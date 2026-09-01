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
  | { kind: "turn-end"; conversationId: string };

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
   * Joined a turn already in progress, after a reload or a reconnect.
   *
   * Whatever was said before this page existed cannot be recovered, so the
   * text here is a fragment. It is withheld rather than shown starting from
   * the middle of a sentence; the whole reply arrives with the transcript
   * when the turn ends.
   */
  resumed?: boolean;
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
      if (event.kind === "turn-end") {
        const next = { ...this.map };
        delete next[id];
        this.map = next;
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
export function seedProgress(working: string[]): void {
  for (const id of working) store.seed(id);
}

export function clearProgress(conversationId: string): void {
  store.clear(conversationId);
}

export function useProgress(): ProgressMap {
  const [map, setMap] = useState<ProgressMap>({});
  useEffect(() => store.subscribe(setMap), []);
  return map;
}
