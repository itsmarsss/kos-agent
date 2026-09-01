import { mkdirSync, realpathSync } from "node:fs";

import { childEnv } from "../sandbox/env.js";
import { resolvePath } from "../jail/resolvePath.js";
import type { ApprovalQueue } from "../ops/approvals.js";
import type { Workspace } from "../store/workspace.js";
import { decide, type Decision } from "./scope.js";

/**
 * Running a Claude Code sub-agent inside the workspace.
 *
 * This is how KOS builds something bigger than one file: a real project with
 * several files, dependencies and tests is what a coding agent is for, and
 * writing it a line at a time through files.write is not.
 *
 * The containment is three things, and the first is the only structural one:
 *
 * 1. **cwd is a folder inside the workspace**, and every path the sub-agent
 *    names is checked against that folder rather than the workspace root, so a
 *    build pointed at one site cannot read another, let alone the database.
 * 2. **Permission decisions come back here** rather than being settled by the
 *    sub-agent's own permission system. Anything outside the folder, and every
 *    shell command, goes into the same approval queue the owner already uses.
 * 3. **The environment is the allow-list**, plus only what the sub-agent needs
 *    to sign in. It does not inherit the owner's other credentials.
 *
 * What this does not do is bound what a shell command can reach once approved.
 * A child process has the host account's authority. That is why every command
 * is shown to the owner before it runs, and why the container in KOS.md is
 * still the backstop rather than this file.
 */

export interface BuildEvent {
  kind: "text" | "tool" | "permission" | "done" | "error";
  text: string;
}

export interface BuildOptions {
  workspace: Workspace;
  approvals: ApprovalQueue;
  /** Workspace-relative folder the build is confined to, e.g. sites/tracker. */
  dir: string;
  /** What to build, in the owner's words. */
  task: string;
  /** Whose approval queue this goes to. */
  userId?: string;
  /** The conversation to resume when an approval is decided. */
  conversationId?: string;
  /** Wall-clock cap. A build that has not finished by then is stopped. */
  timeoutMs?: number;
  /** Turn cap, so a confused sub-agent cannot spend the budget in a loop. */
  maxTurns?: number;
  /**
   * Which model does the building. An alias the CLI understands (sonnet,
   * opus, fable) or a full model name.
   *
   * A build is many turns and each is a model call, so this is the single
   * biggest lever on how long one takes: the subprocess costs about half a
   * second to start, and everything else is the model thinking.
   */
  model?: string;
  onEvent?: (event: BuildEvent) => void;
  /**
   * Handed the controls as soon as there are any, so a caller can offer them
   * without waiting for the build to finish and hand them back.
   */
  onStart?: (control: BuildControl) => void;
}

/**
 * What can be done to a build while it runs.
 *
 * Deliberately not `setPermissionMode`. The SDK offers it, and two of its
 * values (bypassPermissions, dontAsk) skip the canUseTool callback entirely,
 * which is the whole containment: a build could then run any shell command
 * without asking. There is no button for that, and there should not be.
 */
export interface BuildControl {
  /** Say something to it mid-run: a correction, a constraint, an answer. */
  send: (text: string) => void;
  /** Stop what it is doing now but leave it able to take a new instruction. */
  interrupt: () => Promise<void>;
  /** End it. */
  stop: () => void;
}

export interface BuildResult {
  ok: boolean;
  /** The sub-agent's closing message, or why it stopped. */
  summary: string;
  filesTouched: string[];
  askedFor: number;
  approved: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_TURNS = 60;
/** Backstop interval, for a decision made outside this process. */
const POLL_MS = 3000;

/**
 * Wait for the owner to decide a queued action.
 *
 * The sub-agent's permission callback is synchronous in shape: it has to
 * answer before the tool runs. KOS's approval queue is not, because the owner
 * may be asleep. So the build blocks here, which is the honest behaviour:
 * a build waiting on a person has not failed, it is waiting.
 */
async function waitForDecision(
  approvals: ApprovalQueue,
  id: number,
  signal: AbortSignal,
): Promise<"approved" | "denied"> {
  const settled = (): "approved" | "denied" | null => {
    const action = approvals.get(id);
    if (!action || action.status === "pending") return null;
    return action.status === "approved" ? "approved" : "denied";
  };

  // Already decided, or the build is being stopped: no need to wait at all.
  const now = settled();
  if (now) return now;
  if (signal.aborted) return "denied";

  return new Promise<"approved" | "denied">((resolve) => {
    const finish = (outcome: "approved" | "denied"): void => {
      unsubscribe();
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish("denied");

    const unsubscribe = approvals.onDecided((action) => {
      if (action.id !== id) return;
      finish(action.status === "approved" ? "approved" : "denied");
    });
    // A slow backstop as well as the event: a decision made in another process
    // against the same database would never reach the listener, and a build
    // waiting forever on one is worse than checking occasionally.
    const timer = setInterval(() => {
      const outcome = settled();
      if (outcome) finish(outcome);
    }, POLL_MS);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * How the sub-agent authenticates, and what home directory that forces.
 *
 * An API key is the tighter of the two: it is one variable, so the build can
 * be given a home inside its own folder and nothing of the owner's. Without
 * one, Claude Code signs in with the credentials it already holds for the
 * owner, and it needs their real home directory to find them.
 *
 * Handing over the real HOME is a path, not a permission. Reading anything
 * under it still goes through canUseTool and still asks, so what this widens
 * is where the sub-agent's own config lives, not what it can open.
 */
export function credentials(
  scopeDir: string,
  source: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; home: string } {
  const key = source.ANTHROPIC_API_KEY;
  if (key) return { env: { ANTHROPIC_API_KEY: key }, home: scopeDir };

  const home = source.HOME ?? source.USERPROFILE;
  if (!home) {
    throw new Error(
      "a build needs either ANTHROPIC_API_KEY in the harness .env, or a " +
        "signed-in Claude Code on this machine.",
    );
  }
  // Signing in as the owner needs their account name: the credential store
  // is keyed by it, and without it Claude Code reports being logged out even
  // though the credentials are right there. It names the account, not a
  // secret, so it costs nothing to pass.
  const env: Record<string, string> = {};
  if (source.USER) env.USER = source.USER;
  if (source.LOGNAME) env.LOGNAME = source.LOGNAME;
  return { env, home };
}

/**
 * Prepare the folder a build runs in.
 *
 * Through the jail, so a directory argument that tries to point at the
 * workspace root or outside it is refused before anything is started.
 */
export function prepareScope(workspace: Workspace, dir: string): string {
  const raw = dir.replace(/\\/g, "/");
  // An absolute path is refused rather than quietly reread as relative.
  // Stripping the leading slash would turn a request for /etc/kos into
  // <workspace>/etc/kos, which is contained but is not what was asked for,
  // and a caller who cannot tell the difference is a caller being misled.
  if (/^\//.test(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(
      `a build folder is relative to the workspace, not absolute: ${dir}`,
    );
  }
  const clean = raw.replace(/\/+$/g, "");
  if (clean === "" || clean === ".") {
    throw new Error(
      "a build needs its own folder, not the whole workspace. " +
        "Use something like sites/my-app or projects/my-app.",
    );
  }
  const abs = resolvePath(workspace.root, clean);
  mkdirSync(abs, { recursive: true });
  // Real path, because the jail requires a symlink-free root and the scope
  // directory becomes the root every path in the build is checked against.
  return realpathSync(abs);
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const scopeDir = prepareScope(options.workspace, options.dir);
  const auth = credentials(scopeDir);
  const env = { ...childEnv({ home: auth.home }), ...auth.env };

  const controller = new AbortController();
  // Both a timeout and the owner abort the same controller, so the reason has
  // to be recorded when it happens. Without it a build the owner stopped
  // reported itself as having timed out, which is a different thing and the
  // wrong thing to tell them.
  let halted: "timeout" | "owner" | null = null;
  const timer = setTimeout(() => {
    halted = "timeout";
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Handed over before any work starts: a build that cannot be stopped until
  // it returns is one the owner cannot stop at all.
  const stopAll = (): void => {
    halted = "owner";
    closed = true;
    wakeUp();
    controller.abort();
  };

  const filesTouched = new Set<string>();
  const allowedCommands = new Set<string>();
  let askedFor = 0;
  let approved = 0;
  const emit = (kind: BuildEvent["kind"], text: string): void =>
    options.onEvent?.({ kind, text });

  // Imported here rather than at module load: the SDK pulls in a lot, and a
  // workspace that never runs a build should not pay for it at boot.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  /*
   * The task arrives as a stream rather than a string.
   *
   * A string prompt is one-shot: the SDK's control methods are only available
   * in streaming input mode, so passing one meant a build could be killed and
   * nothing else. Watching an agent go the wrong way with no way to say so is
   * the thing this fixes.
   */
  type Inbound = { type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null };
  const inbox: Inbound[] = [
    { type: "user", message: { role: "user", content: options.task }, parent_tool_use_id: null },
  ];
  let wake: (() => void) | null = null;
  let closed = false;

  /** Release the generator if it is parked, exactly once. */
  const wakeUp = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const say = (text: string): void => {
    if (closed) return;
    inbox.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    wakeUp();
  };

  async function* prompts(): AsyncGenerator<Inbound> {
    for (;;) {
      while (inbox.length > 0) yield inbox.shift()!;
      if (closed || controller.signal.aborted) return;
      // Nothing to say yet. Waiting here rather than returning is what keeps
      // the session open for a later instruction.
      await new Promise<void>((resolve) => {
        wake = resolve;
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  const canUseTool = async (
    tool: string,
    input: Record<string, unknown>,
  ): Promise<
    { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }
  > => {
    const verdict: Decision = decide(tool, input, { scopeDir, allowedCommands });

    if (verdict.verdict === "allow") {
      const path = typeof input.file_path === "string" ? input.file_path : undefined;
      if (path) filesTouched.add(path);
      return { behavior: "allow", updatedInput: input };
    }
    if (verdict.verdict === "deny") {
      emit("permission", `refused: ${verdict.reason}`);
      return { behavior: "deny", message: verdict.reason };
    }

    askedFor += 1;
    emit("permission", `waiting on you: ${verdict.reason}`);
    const action = options.approvals.enqueue({
      tool: `build.${tool}`,
      args: input,
      riskTier: "risky",
      reason: `Build in ${options.dir} wants to ${verdict.reason}`,
      ...(options.userId ? { userId: options.userId } : {}),
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    });

    const decision = await waitForDecision(options.approvals, action.id, controller.signal);
    if (decision === "denied") {
      return {
        behavior: "deny",
        message: `the owner declined: ${verdict.reason}. Work around it or stop and say why.`,
      };
    }
    approved += 1;
    emit("permission", `you approved: ${verdict.reason}`);
    // An approved command is approved for the rest of this build, matched
    // exactly. Otherwise `npm test` asks again on every run.
    if (tool === "Bash" && typeof input.command === "string") {
      allowedCommands.add(input.command);
    }
    return { behavior: "allow", updatedInput: input };
  };

  let summary = "";
  let ok = false;

  try {
    const stream = query({
      prompt: prompts(),
      options: {
        cwd: scopeDir,
        // Additional directories are how a sub-agent is granted reach beyond
        // cwd. It is granted none.
        additionalDirectories: [],
        permissionMode: "default",
        ...(options.model ? { model: options.model } : {}),
        canUseTool,
        maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
        env,
        abortController: controller,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            `You are a build sub-agent inside KOS, working in ${options.dir} of ` +
            `the owner's workspace. Stay in this folder. Anything outside it, ` +
            `and every shell command, interrupts the owner for approval, so ` +
            `prefer doing the work in files over shelling out, and batch what ` +
            `you must run. If a request is declined, adapt rather than retrying it.`,
        },
      },
    });

    // Handed over now rather than before: interrupt belongs to the stream, and
    // a control surface that promised it before there was one would have to
    // fail the first time it was used.
    options.onStart?.({
      send: (text) => {
        emit("text", `You: ${text}`);
        say(text);
      },
      interrupt: async () => {
        emit("permission", "you interrupted it");
        await stream.interrupt();
      },
      stop: stopAll,
    });

    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            emit("text", block.text);
          } else if (block.type === "tool_use") {
            emit("tool", block.name);
          }
        }
      } else if (message.type === "result") {
        /*
         * The turn is over. Close the input unless something has been said
         * while it was working.
         *
         * Streaming input keeps the session open for another instruction,
         * which is what makes a build steerable; the cost is that it never
         * ends by itself. Without this the generator parked forever waiting
         * for input that was never coming, the stream never completed, and a
         * build that had finished its work in five seconds sat "running"
         * until the fifteen-minute timeout killed it. That is what "the SDK
         * is slow" was.
         */
        if (inbox.length === 0) {
          closed = true;
          wakeUp();
        }
        ok = message.subtype === "success";
        summary =
          "result" in message && typeof message.result === "string"
            ? message.result
            : message.subtype;
        if (!ok && /not logged in|\/login/i.test(summary)) {
          summary =
            "the build sub-agent could not sign in. Either set " +
            "ANTHROPIC_API_KEY in the harness .env, or sign in with " +
            "`claude` on this machine. Nothing was built.";
        }
      }
    }
    closed = true;
    wakeUp();
    emit("done", summary);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    summary =
      halted === "owner"
        ? "You stopped this build."
        : halted === "timeout"
          ? `Build ran past its time limit and was stopped: ${text}`
          : text;
    emit(halted === "owner" ? "done" : "error", summary);
    ok = false;
  } finally {
    closed = true;
    wakeUp();
    clearTimeout(timer);
  }

  return { ok, summary, filesTouched: [...filesTouched], askedFor, approved };
}
