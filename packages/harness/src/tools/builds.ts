import { BuildRegistry } from "../builds/registry.js";
import { runBuild, type BuildEvent } from "../builds/runner.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import type { ApprovalQueue } from "../ops/approvals.js";
import { RISKY } from "../risk/tiers.js";
import type { Workspace } from "../store/workspace.js";

/**
 * The `builds` tool module: hand a real coding agent a corner of the workspace.
 *
 * KOS writes files well enough for one page. A project with several files,
 * dependencies and tests is what a coding agent is for, so this starts one
 * and holds it to the same approval queue everything else answers to.
 *
 * Risky at the floor and never escalated down. Starting a sub-agent is the
 * most capable thing KOS can do, and the owner should be asked every time
 * rather than KOS deciding that this particular build looked harmless.
 */

export interface BuildsModuleOptions {
  approvals: ApprovalQueue;
  /** Where running builds are listed, so the owner can watch and stop them. */
  registry: BuildRegistry;
  userId?: string;
  /** The conversation asking, so approvals come back to the right thread. */
  currentConversationId?: () => string | undefined;
  /** Progress, so a build that takes minutes does not look like a hang. */
  onEvent?: (event: BuildEvent) => void;
  /**
   * Told when a build the owner is not watching finishes, so the chat that
   * dispatched it can say so.
   */
  onFinished?: (summary: string, conversationId?: string) => void;
  /** Which model builds, read fresh so a settings change applies at once. */
  model?: () => string | undefined;
  /** Opens and closes a live turn around the build, so a reader sees it work. */
  frame?: (phase: "start" | "end") => void;
  /**
   * How long a build may run and how many turns it may take, read fresh so
   * the owner changing them applies to the next build rather than the next
   * restart.
   */
  limits?: () => { timeoutMs: number; maxTurns: number };
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing string arg: ${key}`);
  return v.trim();
}

function defineBuildTools(
  ws: Workspace,
  ctx: ModuleContext,
  options: BuildsModuleOptions,
): void {
  ctx.registerTool(
    {
      name: "builds.run",
      description:
        "Hand a coding sub-agent a folder in the workspace and a task, for " +
        "work too big to write file by file: a multi-file app, a backend, " +
        "something that needs dependencies or tests. It works only inside " +
        "that folder. Anything outside it, and every shell command, asks the " +
        "owner first, so keep the task specific. It returns as soon as the " +
        "agent is running, not when it is done: say it has been started and " +
        "end your turn. The owner is told separately when it finishes. " +
        "For a single page, write the file directly instead.",
      inputSchema: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description:
              "Workspace-relative folder to work in, e.g. sites/expenses. " +
              "Created if missing. Cannot be the workspace root.",
          },
          task: {
            type: "string",
            description:
              "What to build, in full. The sub-agent cannot see this " +
              "conversation, so include anything it needs to know.",
          },
        },
        required: ["dir", "task"],
      },
    },
    async (input) => {
      const dir = str(input, "dir");
      const task = str(input, "task");
      /*
       * Continue an earlier agent's session. Deliberately absent from the
       * schema above: it is for the dashboard waking a finished build, not
       * something the model should be choosing, and a session id is not
       * anything it could know. Read here rather than given a second tool so
       * there is one path that starts a build.
       */
      const resumeSession =
        typeof input["resume"] === "string" && input["resume"].length > 0
          ? input["resume"]
          : undefined;
      const conversationId = options.currentConversationId?.();
      let id = 0;

      options.frame?.("start");
      const limits = options.limits?.();
      /*
       * Dispatched, not awaited.
       *
       * A build takes minutes, and awaiting it held the whole chat turn open
       * for all of them: the owner asked for something to be built and then
       * watched KOS appear to hang until it was done. Handing back as soon as
       * there is an agent to hand back lets the conversation carry on, and
       * the finish arrives as its own note.
       */
      const started = new Promise<number>((resolve) => {
        void runBuild({
          workspace: ws,
          approvals: options.approvals,
          dir,
          task,
          ...(limits
            ? { timeoutMs: limits.timeoutMs, maxTurns: limits.maxTurns }
            : {}),
          ...(options.userId ? { userId: options.userId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(resumeSession ? { resumeSession } : {}),
          ...(options.model?.() ? { model: options.model()! } : {}),
          onStart: (control) => {
            id = options.registry.start({
              dir,
              task,
              ...(conversationId ? { conversationId } : {}),
              control,
            });
            resolve(id);
          },
          onSession: (sessionId) => {
            if (id) options.registry.session(id, sessionId);
          },
          onAsk: (pendingId, settled) => {
            if (id) options.registry.asking(id, pendingId, settled);
          },
          onPhase: (phase) => {
            if (id) options.registry.doing(id, phase);
          },
          onUsage: (usage) => {
            if (id) options.registry.spent(id, usage);
          },
          onEvent: (event) => {
            if (id) options.registry.record(id, event);
            options.onEvent?.(event);
          },
        })
          .then((result) => {
            if (id) {
              options.registry.finish(id, {
                ok: result.ok,
                summary: result.summary,
                files: result.filesTouched,
              });
            }
            const files =
              result.filesTouched.length > 0
                ? ` Files: ${result.filesTouched.slice(0, 10).join(", ")}.`
                : "";
            options.onFinished?.(
              `Agent in ${dir} ${result.ok ? "finished" : "did not finish"}. ${result.summary}${files}`,
              conversationId,
            );
          })
          .catch((err: unknown) => {
            const why = err instanceof Error ? err.message : String(err);
            if (id) {
              options.registry.finish(id, { ok: false, summary: why, files: [] });
            }
            options.onFinished?.(`Agent in ${dir} failed: ${why}`, conversationId);
          })
          // Resolve regardless, so a build that dies before it starts does
          // not leave the dispatching turn waiting forever.
          .finally(() => resolve(id));
      });

      const agentId = await started;
      options.frame?.("end");

      return [
        `Started agent #${agentId} in ${dir}.`,
        "It runs on its own from here and asks the owner directly for anything",
        "risky. Do not wait for it: tell the owner it is running and finish your",
        "turn. They will be told when it is done.",
      ].join(" ");
    },
    RISKY,
  );
}

export function createBuildsModule(options: BuildsModuleOptions): KosModule {
  return {
    manifest: {
      name: "builds",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "builds.run", version: "1.0.0" }],
      riskTier: "risky",
    },
    activate(ctx) {
      const { workspace } = requireServices(ctx);
      defineBuildTools(workspace, ctx, options);
    },
  };
}
