import type { MessageOrigin } from "../models/types.js";
import type { Db } from "../store/db.js";
import type { Attachment } from "./attachments.js";

/**
 * Messages sent while a turn was already running.
 *
 * Turns run one at a time, so a follow-up waits. Where it waits matters: kept
 * only in the browser it was lost on a reload, and written into the session
 * history it was lost anyway, because the turn already running rewrites that
 * history wholesale when it lands and would take the waiting message with it.
 *
 * So it waits here, in a table only the queue touches. The turn that picks it
 * up removes it and records it the ordinary way, which keeps one writer of
 * the transcript rather than two racing.
 */

export interface PendingMessage {
  id: number;
  conversationId: string;
  text: string;
  attachments: Attachment[];
  createdAt: number;
  /**
   * Where it came from, when not typed on the dashboard: a surface and the
   * room on it, a guest, the chat that sent it. Shown under the queued
   * bubble as it will be under the sent one, so a message waiting from
   * Discord reads as one on the dashboard too.
   */
  origin?: MessageOrigin;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  origin_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_messages_conversation
  ON pending_messages (conversation_id, id);
`;

interface Row {
  id: number;
  conversation_id: string;
  text: string;
  attachments_json: string;
  created_at: number;
  origin_json: string | null;
}

function parsed<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    // A row we cannot parse still has its text, which is the part the owner
    // wrote and the part they would miss.
    return fallback;
  }
}

function toMessage(row: Row): PendingMessage {
  const origin = parsed<MessageOrigin | undefined>(row.origin_json, undefined);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    attachments: parsed<Attachment[]>(row.attachments_json, []),
    createdAt: row.created_at,
    ...(origin ? { origin } : {}),
  };
}

export class PendingMessages {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    // A table made before the origin column learns it; the rows are cleared
    // below anyway, so nothing old needs a value.
    const columns = new Set((this.db.prepare(`PRAGMA table_info(pending_messages)`).all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("origin_json")) this.db.exec(`ALTER TABLE pending_messages ADD COLUMN origin_json TEXT`);
    // Anything left from a previous process was never going to run: its queue
    // died with it. Clearing on boot stops a crash mid-turn from leaving a
    // message showing as waiting forever.
    this.db.exec(`DELETE FROM pending_messages`);
  }

  /** Park a message. Returns its id so the turn can claim it. */
  add(conversationId: string, text: string, attachments: Attachment[] = [], origin?: MessageOrigin): number {
    const info = this.db
      .prepare(
        `INSERT INTO pending_messages (conversation_id, text, attachments_json, created_at, origin_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(conversationId, text, JSON.stringify(attachments), this.now(), origin ? JSON.stringify(origin) : null);
    return Number(info.lastInsertRowid);
  }

  /** Claim a parked message: it is about to be run, so it is no longer waiting. */
  take(id: number): void {
    this.db.prepare(`DELETE FROM pending_messages WHERE id = ?`).run(id);
  }

  /** One waiting message, or nothing if it has already been taken. */
  get(id: number): PendingMessage | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pending_messages WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toMessage(row) : undefined;
  }

  /**
   * Change what a waiting message says.
   *
   * Only while it is still waiting: once its turn has started the message has
   * been asked, and editing it then would change the record of a question
   * that was already answered. Returns false if it was already taken.
   */
  edit(id: number, text: string): boolean {
    return (
      this.db
        .prepare(`UPDATE pending_messages SET text = ? WHERE id = ?`)
        .run(text, id).changes > 0
    );
  }

  /** Drop a waiting message. Returns false if its turn already started. */
  remove(id: number): boolean {
    return (
      this.db.prepare(`DELETE FROM pending_messages WHERE id = ?`).run(id)
        .changes > 0
    );
  }

  /** What is still waiting in a conversation, oldest first. */
  forConversation(conversationId: string): PendingMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_messages WHERE conversation_id = ? ORDER BY id`,
      )
      .all(conversationId) as Row[];
    return rows.map(toMessage);
  }

  /** How many are waiting in each conversation, for the chat list. */
  counts(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, COUNT(*) AS n FROM pending_messages
         GROUP BY conversation_id`,
      )
      .all() as { conversation_id: string; n: number }[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.conversation_id] = row.n;
    return out;
  }

  /** Drop everything waiting in a conversation, as when the owner clears it. */
  clear(conversationId: string): void {
    this.db
      .prepare(`DELETE FROM pending_messages WHERE conversation_id = ?`)
      .run(conversationId);
  }
}
