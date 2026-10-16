import { useEffect, useState } from "react";

/**
 * What each conversation is doing, streamed from the host.
 *
 * One connection and one map for the whole app, not one per component. Held
 * per mount, the state was thrown away every time the chat view unmounted, so
 * leaving a running conversation and coming back showed nothing at all until
 * the next event happened to arrive.
 *
 * The steps accumulate rather than replace: a turn is a sequence of thoughts
 * and tool calls, and the reader should watch it build up.
 */

export type ProgressEvent =
  | { kind: "turn-start"; conversationId: string }
  | {
      kind: "tool-start";
      conversationId: string;
      tool: string;
      summary: string;
      input?: Record<string, unknown>;
    }
  | {
      kind: "tool-end";
      conversationId: string;
      tool: string;
      isError: boolean;
      result?: string;
    }
  | { kind: "delta"; conversationId: string; of: "reasoning" | "text"; text: string }
  | { kind: "note"; conversationId: string; text: string }
  | { kind: "congregation"; conversationId: string; members: CongregationMember[] }
  | { kind: "turn-end"; conversationId: string };

/** One conversation a turn is waiting on, when it asked several at once. */
export interface CongregationMember {
  id: string;
  title: string;
  status: "working" | "done" | "failed";
}

/** One thing that happened during a turn, in the order it happened. */
export type LiveStep =
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      tool: string;
      summary: string;
      done: boolean;
      isError: boolean;
      /** Carried so a running call can be opened like a finished one. */
      input?: Record<string, unknown>;
      result?: string;
    };

export interface Live {
  /** Everything so far this turn, oldest first. */
  steps: LiveStep[];
  /** The reply, as it arrives. */
  text: string;
  /** When the turn started, so a wait can show its length. */
  since: number;
  /**
   * The turn is over, but what it did is still the only copy on screen.
   *
   * Dropping the steps on turn-end left a gap: the thoughts and tool calls
   * disappeared, and the transcript that contains them arrived a fetch later,
   * so the end of every turn flashed. The steps stay until the reader has the
   * transcript, and the view stops calling it working in the meantime.
   */
  ended?: boolean;
  /**
   * Joined a turn already in progress, after a reload or a reconnect.
   *
   * Whatever was said before this page existed cannot be recovered, so the
   * text here is a fragment. It is withheld rather than shown starting from
   * the middle of a sentence; the whole reply arrives with the transcript
   * when the turn ends.
   */
  resumed?: boolean;
  /**
   * Who this turn is waiting on, when it asked several conversations at
   * once. Replaced whole on each event, so it always says who is still
   * working; it stays up while the combined reply streams in under it.
   */
  congregation?: { members: CongregationMember[] };
}

export type ProgressMap = Record<string, Live | undefined>;

function reduce(live: Live, event: ProgressEvent): Live {
  const steps = [...live.steps];
  switch (event.kind) {
    case "tool-start":
      steps.push({
        kind: "tool",
        tool: event.tool,
        summary: event.summary,
        done: false,
        isError: false,
        ...(event.input ? { input: event.input } : {}),
      });
      return { ...live, steps };

    case "tool-end": {
      // The most recent unfinished call of that name is the one that ended.
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step?.kind === "tool" && step.tool === event.tool && !step.done) {
          steps[i] = {
            ...step,
            done: true,
            isError: event.isError,
            ...(event.result !== undefined ? { result: event.result } : {}),
          };
          break;
        }
      }
      return { ...live, steps };
    }

    case "delta": {
      if (event.of === "text") return { ...live, text: live.text + event.text };
      // Reasoning accumulates into the trailing thought, so a summary that
      // arrives in fifty pieces reads as one paragraph rather than fifty.
      const last = steps.at(-1);
      if (last?.kind === "reasoning") {
        steps[steps.length - 1] = { kind: "reasoning", text: last.text + event.text };
      } else {
        steps.push({ kind: "reasoning", text: event.text });
      }
      return { ...live, steps };
    }

    case "congregation":
      return { ...live, congregation: { members: event.members } };

    default:
      return live;
  }
}

/**
 * The shared store. One EventSource, opened with the first reader and closed
 * with the last, and a map that outlives any particular view.
 */
class ProgressStore {
  private map: ProgressMap = {};
  private readonly listeners = new Set<(m: ProgressMap) => void>();
  private source: EventSource | null = null;

  subscribe(listener: (m: ProgressMap) => void): () => void {
    this.listeners.add(listener);
    this.open();
    listener(this.map);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  /**
   * Say a conversation is working before any event has arrived.
   *
   * Used when the conversation list reports a turn in flight that started
   * before this page was open: without it, returning to a running chat looks
   * idle until the next delta.
   */
  seed(conversationId: string): void {
    if (this.map[conversationId]) return;
    this.map = {
      ...this.map,
      [conversationId]: { steps: [], text: "", since: Date.now(), resumed: true },
    };
    this.emit();
  }

  /**
   * Drop a finished turn now that its transcript is on screen.
   *
   * Checked here rather than by the caller: whoever fetched a transcript did
   * so a moment ago, and a turn that has started again since must not have
   * its steps thrown away because of a decision made against the old state.
   */
  settled(conversationId: string): void {
    if (this.map[conversationId]?.ended) this.clear(conversationId);
  }

  /** Drop a conversation the server no longer reports as working. */
  clear(conversationId: string): void {
    if (!this.map[conversationId]) return;
    const next = { ...this.map };
    delete next[conversationId];
    this.map = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.map);
  }

  private open(): void {
    if (this.source) return;
    const source = new EventSource("/api/events");
    this.source = source;
    source.onmessage = (message) => {
      let event: ProgressEvent;
      try {
        event = JSON.parse(message.data as string) as ProgressEvent;
      } catch {
        return;
      }
      const id = event.conversationId;
      if (event.kind === "note") {
        // Not part of the live turn: it arrives after one, from work that
        // outlived it. Handed to whoever is listening for notes.
        for (const listener of noteListeners) listener(id, event.text);
        return;
      }
      if (event.kind === "turn-end") {
        // Marked rather than dropped: whoever is showing it swaps it for the
        // transcript, and clears it then.
        const live = this.map[id];
        if (live) this.map = { ...this.map, [id]: { ...live, ended: true } };
        // Told to whoever keeps a list: a reply landing in another thread is
        // what turns its dot green, and the next poll was up to five seconds off.
        for (const listener of endListeners) listener(id);
      } else if (event.kind === "turn-start") {
        this.map = { ...this.map, [id]: { steps: [], text: "", since: Date.now() } };
      } else {
        const live = this.map[id] ?? { steps: [], text: "", since: Date.now() };
        this.map = { ...this.map, [id]: reduce(live, event) };
      }
      this.emit();
    };
    // A dropped connection is not evidence that work stopped; the seed from
    // the conversation list puts back anything still running.
    source.onerror = () => {
      this.map = {};
      this.emit();
    };
  }

  private close(): void {
    this.source?.close();
    this.source = null;
  }
}

const store = new ProgressStore();

/** Tell the store about work the server says is in flight. */
/** Told when something finishes on its own, after the turn that started it. */
const noteListeners = new Set<(conversationId: string, text: string) => void>();
const endListeners = new Set<(conversationId: string) => void>();

/** Called when any turn ends, with the conversation it was in. */
export function onTurnEnd(listener: (conversationId: string) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

export function onNote(
  listener: (conversationId: string, text: string) => void,
): () => void {
  noteListeners.add(listener);
  return () => noteListeners.delete(listener);
}

export function seedProgress(working: string[]): void {
  for (const id of working) store.seed(id);
}

export function clearProgress(conversationId: string): void {
  store.clear(conversationId);
}

/** Hand a finished turn over to the transcript that now holds it. */
export function settleProgress(conversationId: string): void {
  store.settled(conversationId);
}

export function useProgress(): ProgressMap {
  const [map, setMap] = useState<ProgressMap>({});
  useEffect(() => store.subscribe(setMap), []);
  return map;
}
