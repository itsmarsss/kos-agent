import { useEffect, useState } from "react";

/**
 * What each conversation is doing, streamed from the host.
 *
 * The steps accumulate rather than replace: a turn is a sequence of thoughts
 * and tool calls, and the reader should watch it build up, not be shown one
 * label at a time and then handed the whole thing at the end.
 */

export type ProgressEvent =
  | { kind: "turn-start"; conversationId: string }
  | { kind: "tool-start"; conversationId: string; tool: string; summary: string }
  | { kind: "tool-end"; conversationId: string; tool: string; isError: boolean }
  | { kind: "delta"; conversationId: string; of: "reasoning" | "text"; text: string }
  | { kind: "turn-end"; conversationId: string };

/** One thing that happened during a turn, in the order it happened. */
export type LiveStep =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: string; summary: string; done: boolean; isError: boolean };

export interface Live {
  /** Everything so far this turn, oldest first. */
  steps: LiveStep[];
  /** The reply, as it arrives. */
  text: string;
  /** When the turn started, so a wait can show its length. */
  since: number;
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
      });
      return { ...live, steps };

    case "tool-end": {
      // The most recent unfinished call of that name is the one that ended.
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step?.kind === "tool" && step.tool === event.tool && !step.done) {
          steps[i] = { ...step, done: true, isError: event.isError };
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

export function useProgress(): ProgressMap {
  const [steps, setSteps] = useState<ProgressMap>({});

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.onmessage = (message) => {
      let event: ProgressEvent;
      try {
        event = JSON.parse(message.data as string) as ProgressEvent;
      } catch {
        return;
      }
      setSteps((current) => {
        const id = event.conversationId;
        if (event.kind === "turn-end") {
          const next = { ...current };
          delete next[id];
          return next;
        }
        if (event.kind === "turn-start") {
          return { ...current, [id]: { steps: [], text: "", since: Date.now() } };
        }
        const live: Live = current[id] ?? { steps: [], text: "", since: Date.now() };
        return { ...current, [id]: reduce(live, event) };
      });
    };

    // EventSource reconnects on its own; the map is rebuilt from the events
    // that follow, and a stale entry would otherwise claim work that ended.
    source.onerror = () => setSteps({});

    return () => source.close();
  }, []);

  return steps;
}
