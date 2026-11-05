import { readFileSync } from "node:fs";

import { resolvePath } from "../jail/resolvePath.js";
import type { WorkspaceBackup } from "../ops/backup.js";
import { runSandbox, type SandboxResult } from "../sandbox/runner.js";
import { assessSkillRisk } from "./risk.js";

/**
 * The self-improvement loop. An agent-written skill is never trusted on sight:
 * it is sandbox-tested (separate process, throwaway DB copy, dry-run effects),
 * and only then promoted. Safe skills auto-commit via a git snapshot (rollback
 * available); a skill that touches a risky tier needs the owner's yes
 * regardless of a passing test, asked through skills.commit like any risky
 * call, so the ask carries its chat and the turn resumes on the answer. A
 * failing sandbox run is rejected outright.
 */

export type PromoteOutcome =
  | { status: "rejected"; reason: string }
  /** Passed, but risky: skills.commit with the skill's name asks the owner. */
  | { status: "needs_approval"; reason: string }
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
}

export interface SkillPromoterDeps {
  workspaceRoot: string;
  backup: WorkspaceBackup;
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
      // Not queued from here. A queue entry made outside the guarded path
      // had no chat and the wrong arguments: approving it failed with "name
      // is required", nobody heard, and the import it was for never ran.
      return { status: "needs_approval", reason };
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
