/**
 * How a run went, from the steps it took.
 *
 * A turn that ends with a reply ended, which is not the same as working: a
 * schedule whose every step failed still replies "Done.", and recorded on
 * the reply alone it read as Done in Runs, on its blob's card and on
 * Overview. The steps are what happened; the reply is what was said.
 */

/** The steps one run took, and the first that failed, as "tool: what it said". */
export interface StepTally {
  total: number;
  failed: number;
  firstError: string | null;
}

export const NO_STEPS: StepTally = { total: 0, failed: 0, firstError: null };

export type RunOutcome =
  | { status: "ok"; error: null }
  | { status: "partial"; error: string }
  | { status: "error"; error: string };

/**
 * A run's outcome from its steps.
 *
 * `unattended` is a run nobody watched: a schedule. One whose every step
 * failed did nothing it was set to do, so it failed, whatever it said. A
 * chat the owner was in shows them each step as it fails, so there a
 * failed step makes the reply one that finished with errors, never a
 * failure of its own.
 */
export function outcomeOf(steps: StepTally, unattended: boolean): RunOutcome {
  if (steps.failed === 0) return { status: "ok", error: null };
  if (unattended && steps.failed === steps.total) {
    const every = steps.total === 1 ? "Its one step failed" : `All ${steps.total} of its steps failed`;
    return { status: "error", error: steps.firstError ? `${every}. ${steps.firstError}` : `${every}.` };
  }
  return { status: "partial", error: `${steps.failed} of ${steps.total} steps failed.` };
}
