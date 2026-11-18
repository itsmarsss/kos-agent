import type { ModelMessage } from "../models/types.js";

/** How long one call took: its own run, and the wait for the owner's yes when it asked. */
export interface CallTook {
  ms: number;
  waitedMs?: number;
}

/** What the timer needs of an approval: when it was asked and decided. */
interface Asked {
  requestedAt: number;
  decidedAt: number | null;
}

/**
 * How long each tool call takes, by its tool_use id: started when the call
 * starts, ended when it has run, with the wait for the owner's yes taken
 * out, since that is the owner's time and not the tool's. What it measured
 * goes onto the call's result as the turn is kept, so the chat says it
 * after a reload too. A call whose id is unknown (a resumed run, a call
 * outside a turn) is not timed rather than timed wrong. A call that never
 * ends here (denied, refused, thrown) is let go with the turn it was in.
 */
export class CallTimer {
  private readonly running = new Map<string, { started: number; asked?: number }>();
  private readonly took = new Map<string, CallTook>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The call began; when, so a surface can count from it. */
  started(id: string | undefined): number {
    const at = this.now();
    if (id) this.running.set(id, { started: at });
    return at;
  }

  /** The call asked the owner first, as this approval. */
  asked(id: string | undefined, approval: number): void {
    const call = id ? this.running.get(id) : undefined;
    if (call) call.asked = approval;
  }

  /** The call has run: how long it took, without the wait; nothing for a call it did not see start. */
  ended(id: string | undefined, approval: (id: number) => Asked | undefined): CallTook | Record<string, never> {
    const call = id ? this.running.get(id) : undefined;
    if (!id || !call) return {};
    this.running.delete(id);
    const total = this.now() - call.started;
    const asked = call.asked !== undefined ? approval(call.asked) : undefined;
    const waited = asked ? Math.max(0, Math.min(total, (asked.decidedAt ?? this.now()) - asked.requestedAt)) : 0;
    const took: CallTook = { ms: Math.max(0, total - waited), ...(asked ? { waitedMs: waited } : {}) };
    this.took.set(id, took);
    return took;
  }

  /** Calls started and not yet ended or let go: none once their turns are kept. */
  get open(): number {
    return this.running.size + this.took.size;
  }

  /**
   * The turn's messages with each timed call's result saying how long it
   * took. Every call of the turn is then let go, timed or not, so a call
   * that never ended leaves nothing behind.
   */
  stamp(messages: ModelMessage[]): ModelMessage[] {
    for (const m of messages) for (const b of m.content) if (b.type === "tool_use") this.running.delete(b.id);
    if (this.took.size === 0) return messages;
    return messages.map((m) => {
      if (!m.content.some((b) => b.type === "tool_result" && this.took.has(b.toolUseId))) return m;
      return {
        ...m,
        content: m.content.map((b) => {
          if (b.type !== "tool_result") return b;
          const took = this.took.get(b.toolUseId);
          if (!took) return b;
          this.took.delete(b.toolUseId);
          return { ...b, ...took };
        }),
      };
    });
  }
}
