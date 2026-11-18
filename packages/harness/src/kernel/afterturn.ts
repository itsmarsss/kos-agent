import type { NewEvent } from "../memory/events.js";
import { deadline } from "../context/shelf.js";

/**
 * What happens after a turn has answered.
 *
 * Remembering what was said is not part of answering: the reply is already
 * on its way, and remembering may not fail the turn that produced it. It
 * lived inside the kernel because that is where the turn ended. Now it takes
 * what it needs and nothing else, so what the kernel owns is the turn and
 * what this owns is the aftermath.
 */

export interface AfterTurnDeps {
  ownerId: string;
  runs: {
    start: (kind: string) => number;
    finish: (id: number, status: "ok" | "error", error?: string) => void;
  };
  facts: { ingest: (userId: string, text: string, source: string, options?: { evidence?: number[]; scope?: string }) => Promise<unknown> };
  /**
   * The scope a conversation keeps for itself, when it has one: a standing
   * agent with memory of its own. What the owner tells it is its context,
   * not a fact about the owner everywhere.
   */
  scopeOf?: (conversationId: string) => string | undefined;
  embedder: { embed: (texts: string[]) => Promise<number[][]> };
  events: { append: (event: NewEvent, embedding?: number[]) => number };
  conversations: {
    get: (id: string) => { projectSlug: string | null } | undefined;
  };
}

/** How long the exchange waits for its embeddings before it is logged without them. */
export const EMBED_MS = 10_000;

export class AfterTurn {
  constructor(private readonly deps: AfterTurnDeps) {}

  /**
   * Persist what this exchange is worth remembering.
   *
   * Best effort: a failed write must never fail the owner's turn, but it
   * must not be invisible either, so each failure is logged as its own run.
   */
  /**
   * `said` is the owner's words' event when a claim this turn already logged
   * them, so they are not logged twice.
   */
  async remember(userId: string, text: string, reply: string, conversationId?: string, said?: number): Promise<void> {
    const where = conversationId ? this.deps.conversations.get(conversationId) : undefined;
    const record = async (label: string, write: () => Promise<unknown>): Promise<void> => {
      try {
        await write();
      } catch (err) {
        const runId = this.deps.runs.start(label);
        this.deps.runs.finish(runId, "error", err instanceof Error ? err.message : String(err));
      }
    };
    // Both sides of the exchange, each its own event, so what the owner said
    // and what KOS answered are found and trusted separately. The log goes
    // first: a fact drawn from the owner's words points at the event.
    let saidId = said;
    await record("memory.events", async () => {
      const words = text.trim();
      const answered = reply.trim().slice(0, 2000);
      // Bounded: a slow embedder must not hold the turn; the exchange is logged without one.
      const [a, b] = (await Promise.race([this.deps.embedder.embed([words, answered]).catch(() => undefined), deadline(EMBED_MS)])) ?? [undefined, undefined];
      const place = { conversationId: conversationId ?? null, projectSlug: where?.projectSlug ?? null };
      saidId ??= this.deps.events.append({ userId, role: "owner", text: words, ...place }, a);
      if (answered) this.deps.events.append({ userId, role: "agent", text: answered, ...place }, b);
    });
    const scope = conversationId ? this.deps.scopeOf?.(conversationId) : undefined;
    await record("memory.facts", () =>
      this.deps.facts.ingest(userId, text, "chat", { ...(saidId ? { evidence: [saidId] } : {}), ...(scope ? { scope } : {}) }),
    );
  }
}
