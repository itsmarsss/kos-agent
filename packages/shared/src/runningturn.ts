/**
 * Where the running turn's own steps start in a chat's transcript.
 *
 * A turn writes each step to the chat as it lands, so a transcript read
 * mid-turn ends with them: the owner's words that opened it, then its calls
 * and the words heard with them, and no answer yet. A surface that also draws
 * the turn live (the dashboard's live view, a device's story) leaves that
 * tail out while it does, or every step would show twice.
 */

/** A transcript event, as far as where a turn starts is concerned. */
export interface TurnEvent {
  kind: string;
  role?: string;
}

/**
 * The index the running turn's steps start at: after KOS's last words (or a
 * line where the chat was cleared), past the messages that opened the turn.
 * The length when the turn has taken no step.
 */
export function runningTail(events: readonly TurnEvent[]): number {
  let at = events.length;
  while (at > 0) {
    const e = events[at - 1]!;
    if (e.kind === "divider" || (e.kind === "message" && e.role === "kos")) break;
    at -= 1;
  }
  while (at < events.length && events[at]!.kind === "message") at += 1;
  return at;
}
