import type { Inference } from "../agent/loop.js";
import type { NewEvent } from "../memory/events.js";
import { isFixed, titleFromText } from "./conversations.js";
import { looksAutoTitled, nameConversation } from "./naming.js";

/**
 * What happens after a turn has answered.
 *
 * Remembering what was said and naming the conversation are not part of
 * answering: the reply is already on its way, and neither may fail the turn
 * that produced it. They lived inside the kernel because that is where the
 * turn ended. Now they take what they need and nothing else, so what the
 * kernel owns is the turn and what this owns is the aftermath.
 */

export interface AfterTurnDeps {
  ownerId: string;
  /** So nothing is written once the host is closing. */
  isClosed: () => boolean;
  runs: {
    start: (kind: string) => number;
    finish: (id: number, status: "ok" | "error", error?: string) => void;
  };
  facts: { ingest: (userId: string, text: string, source: string, options?: { evidence?: number[] }) => Promise<unknown> };
  embedder: { embed: (texts: string[]) => Promise<number[][]> };
  events: { append: (event: NewEvent, embedding?: number[]) => number };
  conversations: {
    get: (id: string) => { title: string; id: string; channel: string | null; projectSlug: string | null } | undefined;
    rename: (id: string, title: string) => unknown;
  };
  inference: Inference;
}

export class AfterTurn {
  constructor(private readonly deps: AfterTurnDeps) {}

  /**
   * Persist what this exchange is worth remembering.
   *
   * Best effort: a failed write must never fail the owner's turn, but it
   * must not be invisible either, so each failure is logged as its own run.
   */
  async remember(userId: string, text: string, reply: string, conversationId?: string): Promise<void> {
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
    let saidId: number | undefined;
    await record("memory.events", async () => {
      const said = text.trim();
      const answered = reply.trim().slice(0, 2000);
      const [a, b] = await this.deps.embedder.embed([said, answered]);
      const place = { conversationId: conversationId ?? null, projectSlug: where?.projectSlug ?? null };
      saidId = this.deps.events.append({ userId, role: "owner", text: said, ...place }, a);
      if (answered) this.deps.events.append({ userId, role: "agent", text: answered, ...place }, b);
    });
    await record("memory.facts", () => this.deps.facts.ingest(userId, text, "chat", saidId ? { evidence: [saidId] } : {}));
  }

  /**
   * Give a conversation a name once it has said something, if nobody has.
   *
   * Only a title that nobody chose is replaced: the one derived from the
   * first message, or one that still looks auto-titled. A fixed thread is
   * never renamed, and neither is one the owner renamed while the cheap
   * model was thinking.
   */
  async nameIfUnnamed(sessionId: string, text: string, reply: string): Promise<void> {
    const conversation = this.deps.conversations.get(sessionId);
    if (!conversation) return;
    if (isFixed(conversation, this.deps.ownerId)) return;
    if (conversation.title !== titleFromText(text) && !looksAutoTitled(conversation.title)) return;
    const named = await nameConversation(this.deps.inference, text, reply);
    if (!named || this.deps.isClosed()) return;
    const now = this.deps.conversations.get(sessionId);
    if (now && now.title === conversation.title) this.deps.conversations.rename(sessionId, named);
  }
}
