import type { ReactElement } from "react";

import type { Conversation } from "./api.js";

/**
 * What a thread is doing, as a dot.
 *
 * Blue is working, yellow is waiting on you, red is broken, green has
 * something you have not read, grey is read and quiet. A word in a chip
 * said the same thing in more room than the title had, and in a list of
 * twenty rows the colour is what the eye reads anyway; the word is in the
 * tooltip for when it matters. Every row has one, so the titles line up.
 * A schedule uses the same dot: green on, grey off, blue while it runs.
 */

export type DotState = "working" | "needs-you" | "error" | "unread" | "read" | "on" | "off";

export function StatusDot({ state, label }: { state: DotState; label: string }): ReactElement {
  return <span className={`status-dot status-dot--${state}`} role="img" aria-label={label} title={label} />;
}

type Activity = NonNullable<Conversation["activity"]>;

/** The dot for a thread: what it is doing, else whether you have read it. */
export function ActivityDot({
  activity,
  error,
  unread,
  quiet,
}: {
  activity?: Activity;
  error?: string;
  unread?: boolean;
  /** Only the states that want attention: nothing for read or unread. */
  quiet?: boolean;
}): ReactElement | null {
  if (activity === "working") return <StatusDot state="working" label="working" />;
  if (activity === "needs-you") return <StatusDot state="needs-you" label="needs you" />;
  if (activity === "error") return <StatusDot state="error" label={error ? `failed: ${error}` : "failed"} />;
  if (quiet) return null;
  return unread ? <StatusDot state="unread" label="unread" /> : <StatusDot state="read" label="read" />;
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
