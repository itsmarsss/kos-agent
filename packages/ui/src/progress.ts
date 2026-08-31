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
  | { kind: "turn-end"; conversationId: string };

/** Conversation id to the step it is on, or undefined when it is not running. */
export type ProgressMap = Record<string, string | undefined>;

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
        switch (event.kind) {
          case "turn-start":
            next[event.conversationId] = "thinking";
            break;
          case "tool-start":
            next[event.conversationId] = event.summary || event.tool;
            break;
          case "tool-end":
            // Back to thinking: the model is deciding what to do with it.
            next[event.conversationId] = "thinking";
            break;
          case "turn-end":
            delete next[event.conversationId];
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
