import type { WorkspaceBackup } from "../ops/backup.js";
import { runSandbox, type SandboxResult } from "../sandbox/runner.js";

/**
 * The self-improvement loop. An agent-written skill is never trusted on
 * sight, and never judged safe by reading it: a skill is promoted only on
 * the owner's explicit yes (skills.promote and skills.commit ask every
 * time, and no Auto or remembered decision covers them), and promote
 * tests it in the sandbox first (jailed child process, throwaway DB copy,
 * dry-run effects, no network). A failing run is rejected outright; a
 * passing one is committed through a git snapshot, so it can be rolled back.
 */

export type PromoteOutcome =
  | { status: "rejected"; reason: string }
  | { status: "promoted"; sha: string | null };

export interface PromoteInput {
  /** Workspace-relative entry script for the skill. */
  entry: string;
  args?: string[];
}

export interface SkillPromoterDeps {
  workspaceRoot: string;
  backup: WorkspaceBackup;
  /** Injectable for tests; defaults to the real sandbox runner. */
  runSandbox?: (opts: { workspaceRoot: string; entry: string; args?: string[] }) => Promise<SandboxResult>;
}

export class SkillPromoter {
  constructor(private readonly deps: SkillPromoterDeps) {}

  /** Test, then commit: called only once the owner said yes. */
  async promote(input: PromoteInput): Promise<PromoteOutcome> {
    const run = this.deps.runSandbox ?? runSandbox;
    const result = await run({
      workspaceRoot: this.deps.workspaceRoot,
      entry: input.entry,
      ...(input.args ? { args: input.args } : {}),
    });
    if (!result.ok) {
      const reason = result.timedOut ? "sandbox timed out" : result.stderr.trim() || `sandbox exited ${result.exitCode}`;
      return { status: "rejected", reason };
    }
    return { status: "promoted", sha: await this.commit(input.entry) };
  }

  /** Git-snapshot the workspace so the promotion is revertible. */
  async commit(entry: string): Promise<string | null> {
    await this.deps.backup.ensureRepo();
    return this.deps.backup.snapshot(`promote skill ${entry}`);
  }
}
