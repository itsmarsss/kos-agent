/**
 * What a turn is doing, while it does it.
 *
 * A turn takes tens of seconds and several tool calls, and the only thing the
 * reader saw for all of it was the word "thinking". These events say which
 * step it is on, so the wait is legible rather than a guess about whether
 * anything is happening at all.
 *
 * Deliberately not token streaming: the useful signal in an agent turn is the
 * work, not the prose, and the work is what a reader is waiting on.
 */

/** One conversation a turn is waiting on, when it asked several at once. */
export interface CongregationMember {
  id: string;
  title: string;
  status: "working" | "done" | "failed";
}

export type ProgressEvent =
  | { kind: "turn-start"; conversationId: string }
  | {
      kind: "tool-start";
      conversationId: string;
      tool: string;
      summary: string;
      /** What it was called with, so a live call can be opened like a finished one. */
      input?: Record<string, unknown>;
    }
  | {
      kind: "tool-end";
      conversationId: string;
      tool: string;
      isError: boolean;
      /** What came back, capped. Absent when there was nothing to show. */
      result?: string;
    }
  | {
      /** A piece of the answer, or of the model's own account of its thinking. */
      kind: "delta";
      conversationId: string;
      of: "reasoning" | "text";
      text: string;
    }
  | {
      /**
       * Something finished on its own, after the turn that started it ended.
       * Shown where a command's answer is shown: it is news, not part of the
       * conversation.
       */
      kind: "note";
      conversationId: string;
      text: string;
    }
  | {
      /**
       * Who a turn is waiting on, when it asked several conversations at
       * once. Sent as the fan-out starts and again each time a member
       * settles, so the roster on screen always says who is still working.
       */
      kind: "congregation";
      conversationId: string;
      members: CongregationMember[];
    }
  | { kind: "turn-end"; conversationId: string };

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * How much of one turn is kept so a reader arriving late can catch up.
 *
 * A turn is a few dozen events. The cap is a backstop against a runaway loop
 * filling memory, not an expected limit.
 */
const MAX_REPLAY_EVENTS = 400;
/** Reasoning arrives as many small deltas; this bounds the text kept per turn. */
const MAX_REPLAY_TEXT = 40_000;

/**
 * A fan-out that remembers the turn currently in flight.
 *
 * It used to remember nothing, which was fine for a reader who stayed and
 * wrong for one who reloaded: every thought and tool call already streamed was
 * gone, and the page showed a spinner over an empty space until the turn
 * happened to finish. What is kept is only the turn in progress, discarded
 * when it ends, because from that point the transcript is the record.
 */
export class ProgressBus {
  private readonly listeners = new Set<ProgressListener>();
  /** Events of the in-flight turn, per conversation. */
  private readonly inFlight = new Map<string, ProgressEvent[]>();
  private readonly textSize = new Map<string, number>();

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Everything needed to draw the turns currently running, in the order they
   * happened. Replayed to a reader as it connects.
   */
  snapshot(): ProgressEvent[] {
    return [...this.inFlight.values()].flat();
  }

  /** Conversations with a turn in flight right now. */
  running(): string[] {
    return [...this.inFlight.keys()];
  }

  private remember(event: ProgressEvent): void {
    const id = event.conversationId;
    if (event.kind === "turn-start") {
      this.inFlight.set(id, [event]);
      this.textSize.set(id, 0);
      return;
    }
    if (event.kind === "turn-end") {
      // The transcript is the record from here; keeping this would mean
      // replaying a turn that has already landed in the message list.
      this.inFlight.delete(id);
      this.textSize.delete(id);
      return;
    }
    const kept = this.inFlight.get(id);
    if (!kept) return;
    if (kept.length >= MAX_REPLAY_EVENTS) return;
    if (event.kind === "delta") {
      const size = (this.textSize.get(id) ?? 0) + event.text.length;
      if (size > MAX_REPLAY_TEXT) return;
      this.textSize.set(id, size);
    }
    kept.push(event);
  }

  emit(event: ProgressEvent): void {
    this.remember(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener is a broken reader, not a broken turn.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
