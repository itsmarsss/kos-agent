import type { MessageOrigin } from "../models/types.js";
import { scrubDeep } from "../secrets/scrub.js";

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
      /** When it began, epoch ms, so a surface can count how long it runs. */
      at?: number;
    }
  | {
      kind: "tool-end";
      conversationId: string;
      tool: string;
      isError: boolean;
      /** What came back, capped. Absent when there was nothing to show. */
      result?: string;
      /** How long it ran, ms, not counting the wait for the owner's yes. */
      ms?: number;
      /** How long it waited on the owner's yes, ms, when it asked. */
      waitedMs?: number;
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
  | {
      /**
       * The chat has a new title: named by KOS as its first turn started, or
       * renamed by the owner. Not part of any turn, and never replayed: a
       * reader arriving later reads the title with the chat.
       */
      kind: "renamed";
      conversationId: string;
      title: string;
    }
  | { kind: "turn-end"; conversationId: string };

export type ProgressListener = (event: ProgressEvent) => void;

/** What takes secrets out of a turn's words, and how much of a stream it needs held back to see a value whole. */
export interface ProgressScrubber {
  scrub(text: string): string;
  holdBack(): number;
}

/**
 * How much of a turn's streamed words are kept so a reader arriving late can
 * catch up. Reasoning arrives as many small deltas; each run of them is kept
 * as one entry, and past this the oldest words go first.
 */
const MAX_REPLAY_TEXT = 40_000;
/** How much of a call's input a replayed step keeps: a file being written is words too. */
const MAX_REPLAY_INPUT = 2_000;

/**
 * An event with every secret value taken out of the words it carries: what
 * was said, a step's summary, input and result. The answer as it streams is
 * scrubbed apart, in ProgressBus.stream, since a value may be split across
 * its pieces.
 */
function scrubbed(event: ProgressEvent, scrub: (text: string) => string): ProgressEvent {
  switch (event.kind) {
    case "turn-start":
    case "heard":
      return event.said === undefined ? event : { ...event, said: scrub(event.said) };
    case "tool-start":
      return { ...event, summary: scrub(event.summary), ...(event.input ? { input: scrubDeep(event.input, scrub) } : {}) };
    case "tool-end":
      return event.result === undefined ? event : { ...event, result: scrub(event.result) };
    case "note":
      return { ...event, text: scrub(event.text) };
    default:
      return event;
  }
}

/** A step's input as a replay keeps it: whole when small, each long string cut, and none past that. */
function replayedInput(input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (JSON.stringify(input).length <= MAX_REPLAY_INPUT) return input;
  const cut = Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, typeof v === "string" && v.length > MAX_REPLAY_INPUT / 4 ? `${v.slice(0, MAX_REPLAY_INPUT / 4)}…` : v]),
  );
  return JSON.stringify(cut).length <= MAX_REPLAY_INPUT ? cut : undefined;
}

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

  /** Streamed words not yet passed on, per conversation: a secret's start, perhaps, its rest still to come. */
  private readonly held = new Map<string, { of: "reasoning" | "text"; text: string }>();

  /** `scrubber` takes secret values out of an event's words before anyone sees or keeps them. */
  constructor(private readonly scrubber: ProgressScrubber = { scrub: (text) => text, holdBack: () => 0 }) {}

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
    if (event.kind === "renamed") return;
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
    if (event.kind === "tool-start" && event.input) {
      const { input, ...step } = event;
      const short = replayedInput(input);
      kept.push(short ? { ...step, input: short } : step);
      return;
    }
    if (event.kind !== "delta") {
      kept.push(event);
      return;
    }
    // A run of words between two steps is one entry, as a reader draws it.
    const last = kept.at(-1);
    // The pieces were scrubbed whole as they streamed, so joined they need nothing more.
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
    if (given.kind === "delta") return this.stream(given);
    // Words held for this conversation go first, so they stay ahead of what follows them.
    this.release(given.conversationId);
    // When a turn began, so a reader joining it later counts from then, not from when it joined.
    const stamped = given.kind === "turn-start" && given.at === undefined ? { ...given, at: Date.now() } : given;
    this.deliver(scrubbed(stamped, (text) => this.scrubber.scrub(text)));
  }

  /**
   * A piece of streamed words, passed on scrubbed, all but its end: the
   * scrubber's hold-back is kept until more come, so a secret split across
   * pieces is whole when it is looked for. What is held goes
   * out before the turn's next step, or its end.
   */
  private stream(event: Extract<ProgressEvent, { kind: "delta" }>): void {
    const id = event.conversationId;
    if (this.held.get(id)?.of !== event.of) this.release(id);
    const clean = this.scrubber.scrub((this.held.get(id)?.text ?? "") + event.text);
    let cut = Math.max(0, clean.length - this.scrubber.holdBack());
    // Never between the halves of a character.
    if (cut > 0 && cut < clean.length && /[\uD800-\uDBFF]/.test(clean[cut - 1]!)) cut -= 1;
    if (cut < clean.length) this.held.set(id, { of: event.of, text: clean.slice(cut) });
    else this.held.delete(id);
    if (cut > 0) this.deliver({ ...event, text: clean.slice(0, cut) });
  }

  /** What is held for a conversation, passed on now. */
  private release(id: string): void {
    const held = this.held.get(id);
    if (!held) return;
    this.held.delete(id);
    this.deliver({ kind: "delta", conversationId: id, of: held.of, text: held.text });
  }

  private deliver(event: ProgressEvent): void {
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
