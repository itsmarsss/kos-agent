import { readFileSync } from "node:fs";

import { resolvePath } from "../jail/resolvePath.js";
import type { ApprovalQueue } from "../ops/approvals.js";
import type { WorkspaceBackup } from "../ops/backup.js";
import { runSandbox, type SandboxResult } from "../sandbox/runner.js";
import { assessSkillRisk } from "./risk.js";

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
  /**
   * Force the risky path. The harness reads the skill's source and decides on
   * its own; this only ever adds caution, it cannot clear a risky verdict.
   */
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

    // Passing test is necessary but not sufficient. The sandbox mocks external
    // effects, so a clean run says nothing about what the skill does for real:
    // the verdict comes from reading the source, never from the caller.
    const assessed = this.assess(input.entry);
    if (input.risky || assessed.risky) {
      const reason = assessed.reasons.length
        ? `skill uses a risky capability: ${assessed.reasons.join(", ")}`
        : "skill uses a risky capability";
      const action = this.deps.approvals.enqueue({
        // Deliberately not skills.promote: approving re-executes the queued
        // tool, and re-entering promote would re-assess and re-queue forever.
        tool: "skills.commit",
        args: { entry: input.entry },
        riskTier: "risky",
        reason,
        ...(input.userId ? { userId: input.userId } : {}),
      });
      return { status: "pending_approval", actionId: action.id };
    }

    return { status: "promoted", sha: await this.commit(input.entry) };
  }

  /** Read the skill and classify it; unreadable source is risky by default. */
  private assess(entry: string): { risky: boolean; reasons: string[] } {
    try {
      const abs = resolvePath(this.deps.workspaceRoot, entry);
      return assessSkillRisk(readFileSync(abs, "utf8"));
    } catch (err) {
      return {
        risky: true,
        reasons: [`could not read skill: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  /** Git-snapshot the workspace so the promotion is revertible. */
  async commit(entry: string): Promise<string | null> {
    await this.deps.backup.ensureRepo();
    return this.deps.backup.snapshot(`promote skill ${entry}`);
  }
}
