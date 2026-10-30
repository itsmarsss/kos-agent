/**
 * What happens in the kernel, told to modules.
 *
 * Modules compose through shared surfaces: the workspace, the tool
 * registry, the manifest, and the cron and event layer. The first three
 * existed; this is the fourth. A module subscribes when it activates and is
 * unsubscribed when it is switched off, the same way its tools are taken
 * back, so a module that is gone is gone.
 *
 * A handler that throws is contained and reported, never propagated: a
 * module reacting to a turn ending must not be able to end the next one.
 */

import type { KeptFile } from "../kernel/attachments.js";
import type { MessageFrom } from "../models/types.js";

export type KernelEvent =
  | { kind: "turn:start"; conversationId: string; projectSlug: string | null }
  | { kind: "turn:end"; conversationId: string; projectSlug: string | null }
  /**
   * A turn that ended with words: what was said to the chat and what it
   * answered, with where the words came from, so a surface that shows the
   * chat elsewhere can show this exchange too, and skip its own.
   */
  | {
      kind: "turn:said";
      conversationId: string;
      projectSlug: string | null;
      text: string;
      reply: string;
      origin: "owner" | "system";
      channel: string | null;
      files: KeptFile[];
      /** The turn waited on an approval and this is the answer after it: the surface it came from has nothing posting it. */
      resumed?: boolean;
      /** Who passed the words on, when a chat or a schedule did: the mirror speaks as them, never as the owner. */
      from?: MessageFrom;
    }
  /** A slash command run in a chat: the line as typed and what it answered, with where it was typed. */
  | { kind: "command:ran"; conversationId: string; text: string; reply: string; channel: string | null }
  /** A chat deleted for good; whatever stood for it on a surface goes with it. */
  | { kind: "chat:deleted"; conversationId: string }
  | { kind: "tool:end"; tool: string; isError: boolean; conversationId: string | null }
  | { kind: "approval:requested"; id: number; tool: string; conversationId: string | null }
  | { kind: "approval:decided"; id: number; approved: boolean; decidedBy: string | null }
  | { kind: "cron:fired"; jobId: number; name: string; ok: boolean; error: string | null }
  /** The kill switch was thrown or released: whatever runs on its own stops at once. */
  | { kind: "halt:changed"; halted: boolean }
  | { kind: "module:enabled"; name: string }
  | { kind: "module:disabled"; name: string };

export type EventKind = KernelEvent["kind"];

export type EventHandler<K extends EventKind = EventKind> = (
  event: Extract<KernelEvent, { kind: K }>,
) => void | Promise<void>;

/** What a module gets: subscribe, and say something of its own. */
export interface KernelEvents {
  on<K extends EventKind>(kind: K | "*", handler: EventHandler<K>): () => void;
  emit(event: KernelEvent): void;
}

export class EventBus implements KernelEvents {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(private readonly report: (message: string) => void = () => undefined) {}

  on<K extends EventKind>(kind: K | "*", handler: EventHandler<K>): () => void {
    const set = this.handlers.get(kind) ?? new Set<EventHandler>();
    set.add(handler as unknown as EventHandler);
    this.handlers.set(kind, set);
    return () => {
      set.delete(handler as unknown as EventHandler);
      if (set.size === 0) this.handlers.delete(kind);
    };
  }

  emit(event: KernelEvent): void {
    for (const key of [event.kind, "*"]) {
      for (const handler of this.handlers.get(key) ?? []) {
        try {
          const out = handler(event as never);
          if (out && typeof (out as Promise<void>).catch === "function") {
            (out as Promise<void>).catch((err: unknown) => this.report(this.describe(event, err)));
          }
        } catch (err) {
          this.report(this.describe(event, err));
        }
      }
    }
  }

  /** How many handlers listen, for tests and the status line. */
  count(kind?: EventKind | "*"): number {
    if (kind) return this.handlers.get(kind)?.size ?? 0;
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }

  private describe(event: KernelEvent, err: unknown): string {
    return `a module's ${event.kind} handler failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
