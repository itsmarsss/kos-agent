import type { MessageOrigin } from "../models/types.js";

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
  | {
      kind: "turn-start";
      conversationId: string;
      /**
       * The owner's words, when the turn came in from somewhere other than
       * the page showing it: a Discord message showed on the dashboard as a
       * spinner with nothing above it until the turn ended.
       */
      said?: string;
      /** Where they came from, as the transcript will say it. */
      origin?: MessageOrigin;
      /** The files that came with the words, already kept, so the page can show them at once. */
      files?: { name: string; path: string }[];
      /** The surface those words came in on. */
      from?: string;
      /** The waiting row those words were, when they waited behind another turn. */
      pendingId?: number;
      /** When it began, epoch ms; stamped by the bus when the sender leaves it out. */
      at?: number;
    }
  | {
      kind: "tool-start";
      conversationId: string;
      tool: string;
      summary: string;
      /** What it was called with, so a live call can be opened like a finished one. */
      input?: Record<string, unknown>;
      /**
       * A browser step that works in the owner's own Chrome, not KOS's: a
       * surface showing KOS's browser has nothing of this step to show.
       */
      yours?: true;
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
  | {
      /**
       * A picture of what a step saw (a tab, a screen), kept as a frame:
       * every surface that shows the turn shows it under that step. `site`
       * is the host of the page a browser frame shows, so a surface can
       * leave out a site the owner hid there; a screen's frame has none.
       */
      kind: "frame";
      conversationId: string;
      tool: string;
      frameId: number;
      toolUseId?: string;
      site?: string;
    }
  | {
      /**
       * Words said to the chat while its turn ran, heard by that turn at
       * its last step: a surface that shows the chat elsewhere shows them
       * where they were heard. `from` is the surface they were said on.
       */
      kind: "heard";
      conversationId: string;
      said: string;
      /** The waiting row the words were, so a surface showing it queued knows it is taken. */
      pendingId?: number;
      from?: string;
    }
  | {
      /**
       * The turn carries on in a fresh query, its pictures full: it looks
       * at the screen again before its next step, which takes a moment.
       */
      kind: "fresh";
      conversationId: string;
    }
  | { kind: "turn-end"; conversationId: string };

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * How much of a turn's streamed words are kept so a reader arriving late can
 * catch up. Reasoning arrives as many small deltas; each run of them is kept
 * as one entry, and past this the oldest words go first.
 */
const MAX_REPLAY_TEXT = 40_000;

/**
 * A fan-out that remembers the turn currently in flight.
 *
 * It used to remember nothing, which was fine for a reader who stayed and
 * wrong for one who reloaded: every thought and tool call already streamed was
 * gone, and the page showed a spinner over an empty space until the turn
 * happened to finish. What is kept is only the turn in progress, discarded
 * when it ends, because from that point the transcript is the record.
 *
 * Every step is kept: a cap on events, filled by deltas within a few steps,
 * replayed a long turn as its first few steps alone. Only words are capped.
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
    if (event.kind !== "delta") {
      kept.push(event);
      return;
    }
    // A run of words between two steps is one entry, as a reader draws it.
    const last = kept.at(-1);
    if (last?.kind === "delta" && last.of === event.of) kept[kept.length - 1] = { ...last, text: last.text + event.text };
    else kept.push({ ...event });
    const size = (this.textSize.get(id) ?? 0) + event.text.length;
    this.textSize.set(id, size - this.forget(kept, size - MAX_REPLAY_TEXT));
  }

  /** The oldest words of a turn, up to `over` characters, gone; how many went. */
  private forget(kept: ProgressEvent[], over: number): number {
    let gone = 0;
    for (let i = 0; i < kept.length && gone < over; ) {
      const e = kept[i]!;
      if (e.kind !== "delta") {
        i += 1;
        continue;
      }
      const cut = Math.min(e.text.length, over - gone);
      gone += cut;
      if (cut === e.text.length) kept.splice(i, 1);
      else {
        kept[i] = { ...e, text: e.text.slice(cut) };
        i += 1;
      }
    }
    return gone;
  }

  emit(given: ProgressEvent): void {
    // When a turn began, so a reader joining it later counts from then, not from when it joined.
    const event = given.kind === "turn-start" && given.at === undefined ? { ...given, at: Date.now() } : given;
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
