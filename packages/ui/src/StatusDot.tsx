import type { ReactElement } from "react";

import type { Conversation } from "./api.js";

/**
 * What a thread is doing, as a dot.
 *
 * Blue is working, yellow is waiting on you, red is broken. A word in a
 * chip said the same thing in more room than the title had, and in a list
 * of twenty rows the colour is what the eye reads anyway; the word is in the
 * tooltip for when it matters.
 */

export type DotState = "working" | "needs-you" | "error";

export function StatusDot({ state, label }: { state: DotState; label: string }): ReactElement {
  return <span className={`status-dot status-dot--${state}`} role="img" aria-label={label} title={label} />;
}

type Activity = NonNullable<Conversation["activity"]>;

/** The dot for a thread's activity, or nothing when it is idle. */
export function ActivityDot({ activity, error }: { activity?: Activity; error?: string }): ReactElement | null {
  if (activity === "working") return <StatusDot state="working" label="working" />;
  if (activity === "needs-you") return <StatusDot state="needs-you" label="needs you" />;
  if (activity === "error") return <StatusDot state="error" label={error ? `failed: ${error}` : "failed"} />;
  return null;
}

/** What to say about the chat KOS opened for a failure, by what it is doing now. */
export function fixLabel(activity: Activity): string {
  switch (activity) {
    case "working":
      return "KOS is on it";
    case "needs-you":
      return "KOS needs you";
    case "error":
      return "KOS could not finish";
    default:
      return "KOS looked at it";
  }
}
