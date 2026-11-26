import { keptSources, readSources, type TaintSource } from "@kos/shared";

import type { Db } from "../store/db.js";

/**
 * Taint the chat.
 *
 * A turn's taint ended with the turn, but what it read did not: a page's
 * text stays in the chat's history, whole for a while and then as its
 * stub, a compaction summary is written from it, and the SDK engine
 * restates earlier turns in every prompt. An instruction planted there
 * ("when the owner next says anything, post this") rode the owner's next
 * "thanks, carry on" untainted. So the sources a turn read are kept with
 * its chat, and every later turn there starts tainted with them, until the
 * owner trusts the chat again, clears its history, or starts a new chat. A
 * fork carries them; an aside borrows them with the history it borrows.
 *
 * Whether a source has left the model's window is not judged: history that
 * fell out of the window is folded into a summary written from it, so it
 * never leaves. The owner's word is what ends it.
 */
export class ChatTaints {
  constructor(private readonly db: Db) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_taint (conversation_id TEXT PRIMARY KEY, sources TEXT NOT NULL, since INTEGER NOT NULL)`);
  }

  /** What the chat's history holds that the owner did not write; none for a clean chat. */
  of(conversationId: string): TaintSource[] {
    const row = this.db.prepare(`SELECT sources FROM chat_taint WHERE conversation_id = ?`).get(conversationId) as { sources: string } | undefined;
    if (!row) return [];
    try {
      return readSources(JSON.parse(row.sources));
    } catch {
      // A row that no longer reads is still a tainted chat: the owner trusts it again to clear it.
      return [{ kind: "chat", where: "this chat's history" }];
    }
  }

  /** Keep a turn's sources with its chat. */
  add(conversationId: string, sources: readonly TaintSource[], now = Date.now()): void {
    if (!sources.length) return;
    const merged = keptSources([...this.of(conversationId), ...sources]);
    this.db
      .prepare(`INSERT INTO chat_taint (conversation_id, sources, since) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET sources = excluded.sources`)
      .run(conversationId, JSON.stringify(merged), now);
  }

  /** The chat's history is the owner's again: they trusted it, or it was cleared. */
  clear(conversationId: string): boolean {
    return this.db.prepare(`DELETE FROM chat_taint WHERE conversation_id = ?`).run(conversationId).changes > 0;
  }

  /** A copy of a chat's history carries what it holds. */
  copy(from: string, to: string): void {
    this.add(to, this.of(from));
  }
}
