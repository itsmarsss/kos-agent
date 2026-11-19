/**
 * What became of a tool call that was held, as its result says it.
 *
 * KOS.md: a call held for approval must never read as one that ran. The
 * harness writes these results with stable prefixes so the model, the
 * transcript and every surface read the same outcome from the same words,
 * rather than each guessing from prose or from the call's error flag (a
 * denied call is not an error, and it did not run either).
 */

/** The owner said no. */
export const DENIED_PREFIX = "The owner denied this: ";
/** Nobody answered within the wait. */
export const LAPSED_PREFIX = "No answer in time; it was not done: ";
/** How a refusal read before, still in older transcripts. */
export const OLD_DENIED_PREFIX = "not approved (pending #";
/** The owner said yes, and the call ran. */
export const APPROVED_PREFIX = "The owner approved this";
/** A second call in one step, sent back unrun. */
export const NOT_RUN_PREFIX = "not run: ";

/** How a held call ended, when its result says it did not simply run. */
export type CallOutcome = "approved" | "denied" | "lapsed" | "not run";

/** The outcome a result names, or nothing for a call that ran unasked. */
export function outcomeOf(result: string | undefined): CallOutcome | undefined {
  if (!result) return undefined;
  if (result.startsWith(DENIED_PREFIX) || result.startsWith(OLD_DENIED_PREFIX)) return "denied";
  if (result.startsWith(LAPSED_PREFIX)) return "lapsed";
  if (result.startsWith(NOT_RUN_PREFIX)) return "not run";
  if (result.startsWith(APPROVED_PREFIX)) return "approved";
  return undefined;
}

/** Whether a result is an ask that came to nothing, in today's words or the old ones. */
export function isUndone(result: string): boolean {
  const outcome = outcomeOf(result);
  return outcome === "denied" || outcome === "lapsed";
}
