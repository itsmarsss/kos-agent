import { useEffect, useState } from "react";

/**
 * What each conversation is doing right now, streamed from the host.
 *
 * A turn runs for tens of seconds across several tool calls and the reader saw
 * one static word for all of it. This carries the step, so waiting is legible.
 * Nothing here is authoritative: a reconnect starts empty and the polled
 * conversation list fills the gap.
 */

export type ProgressEvent =
  | { kind: "turn-start"; conversationId: string }
  | { kind: "tool-start"; conversationId: string; tool: string; summary: string }
  | { kind: "tool-end"; conversationId: string; tool: string; isError: boolean }
  | { kind: "delta"; conversationId: string; of: "reasoning" | "text"; text: string }
  | { kind: "turn-end"; conversationId: string };

/** What a conversation is doing, while it does it. */
export interface Live {
  /** The tool running now, or undefined while the model is working. */
  step?: string;
  /** The model's own account of what it is working out, as it arrives. */
  reasoning: string;
  /** The reply, as it arrives. */
  text: string;
  /** When the turn started, so a wait can show its length. */
  since: number;
}

export type ProgressMap = Record<string, Live | undefined>;

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
        const next = { ...current };
        const id = event.conversationId;
        const live: Live = next[id] ?? { reasoning: "", text: "", since: Date.now() };
        switch (event.kind) {
          case "turn-start":
            next[id] = { reasoning: "", text: "", since: Date.now() };
            break;
          case "tool-start":
            next[id] = { ...live, step: event.summary || event.tool };
            break;
          case "tool-end":
            // The reasoning that led here is spent; what comes next is new.
            next[id] = { ...live, step: undefined, reasoning: "" };
            break;
          case "delta":
            next[id] =
              event.of === "reasoning"
                ? { ...live, reasoning: live.reasoning + event.text }
                : { ...live, text: live.text + event.text };
            break;
          case "turn-end":
            delete next[id];
            break;
        }
        return next;
      });
    };

    // EventSource reconnects on its own; the map is rebuilt from the events
    // that follow, and a stale entry would otherwise claim work that ended.
    source.onerror = () => setSteps({});

    return () => source.close();
  }, []);

  return steps;
}
