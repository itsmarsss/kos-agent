import type { ApprovalQueue } from "../ops/approvals.js";
import type { WorkspaceBackup } from "../ops/backup.js";
import { runSandbox, type SandboxResult } from "../sandbox/runner.js";

/**
 * The self-improvement loop. An agent-written skill is never trusted on sight:
 * it is sandbox-tested (separate process, throwaway DB copy, dry-run effects),
 * and only then promoted. Safe skills auto-commit via a git snapshot (rollback
 * available); a skill that touches a risky tier goes to the approval queue
 * regardless of a passing test. A failing sandbox run is rejected outright.
 */

export type PromoteOutcome =
  | { status: "rejected"; reason: string }
  | { status: "pending_approval"; actionId: number }
  | { status: "promoted"; sha: string | null };

export interface PromoteInput {
  /** Workspace-relative entry script for the skill. */
  entry: string;
  /** True if the skill uses any risky-tier capability. */
  risky?: boolean;
  args?: string[];
  userId?: string;
}

export interface SkillPromoterDeps {
  workspaceRoot: string;
  backup: WorkspaceBackup;
  approvals: ApprovalQueue;
  /** Injectable for tests; defaults to the real sandbox runner. */
  runSandbox?: (opts: {
    workspaceRoot: string;
    entry: string;
    args?: string[];
  }) => Promise<SandboxResult>;
}

export class SkillPromoter {
  constructor(private readonly deps: SkillPromoterDeps) {}

  async promote(input: PromoteInput): Promise<PromoteOutcome> {
    const run = this.deps.runSandbox ?? runSandbox;
    const result = await run({
      workspaceRoot: this.deps.workspaceRoot,
      entry: input.entry,
      ...(input.args ? { args: input.args } : {}),
    });

    if (!result.ok) {
      const reason = result.timedOut
        ? "sandbox timed out"
        : result.stderr.trim() || `sandbox exited ${result.exitCode}`;
      return { status: "rejected", reason };
    }

    // Passing test is necessary but not sufficient: risky skills need approval.
    if (input.risky) {
      const action = this.deps.approvals.enqueue({
        tool: "skills.promote",
        args: { entry: input.entry },
        riskTier: "risky",
        reason: "skill uses a risky capability",
        ...(input.userId ? { userId: input.userId } : {}),
      });
      return { status: "pending_approval", actionId: action.id };
    }

    await this.deps.backup.ensureRepo();
    const sha = await this.deps.backup.snapshot(`promote skill ${input.entry}`);
    return { status: "promoted", sha };
  }
}
