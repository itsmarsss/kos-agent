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
  onEvent?: (event: BuildEvent) => void;
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
/** How often a blocked permission request looks to see if it was decided. */
const POLL_MS = 500;

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
  for (;;) {
    if (signal.aborted) return "denied";
    const action = approvals.get(id);
    if (action && action.status !== "pending") {
      return action.status === "approved" ? "approved" : "denied";
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
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
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const filesTouched = new Set<string>();
  const allowedCommands = new Set<string>();
  let askedFor = 0;
  let approved = 0;
  const emit = (kind: BuildEvent["kind"], text: string): void =>
    options.onEvent?.({ kind, text });

  // Imported here rather than at module load: the SDK pulls in a lot, and a
  // workspace that never runs a build should not pay for it at boot.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

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
      prompt: options.task,
      options: {
        cwd: scopeDir,
        // Additional directories are how a sub-agent is granted reach beyond
        // cwd. It is granted none.
        additionalDirectories: [],
        permissionMode: "default",
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
    emit("done", summary);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    summary = controller.signal.aborted ? `build timed out: ${text}` : text;
    emit("error", summary);
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  return { ok, summary, filesTouched: [...filesTouched], askedFor, approved };
}
