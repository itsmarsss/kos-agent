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

export type ProgressEvent =
  | { kind: "turn-start"; conversationId: string }
  | {
      kind: "tool-start";
      conversationId: string;
      tool: string;
      summary: string;
    }
  | {
      kind: "tool-end";
      conversationId: string;
      tool: string;
      isError: boolean;
    }
  | { kind: "turn-end"; conversationId: string };

export type ProgressListener = (event: ProgressEvent) => void;

/**
 * A fan-out with no memory: a listener that arrives mid-turn hears the rest of
 * it, and one that goes away stops costing anything. State that has to survive
 * a reconnect lives in the conversation list, which is polled.
 */
export class ProgressBus {
  private readonly listeners = new Set<ProgressListener>();

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ProgressEvent): void {
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
