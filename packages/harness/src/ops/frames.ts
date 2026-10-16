import type { Db } from "../store/db.js";

/**
 * What the browser showed after each step, kept.
 *
 * A reply that says "the price was 40" is a claim; the page it was read
 * from is the evidence. A small picture per browser step, keyed to the
 * tool call it followed, lets the thread show what the agent saw, and lets
 * the owner check it later. Kept small and capped per conversation, since
 * a long session would otherwise be a long film.
 */

export interface BrowserFrameRecord {
  id: number;
  conversationId: string;
  /** The model's tool-use id the step ran under, when the engine gave one. */
  toolUseId: string | null;
  tool: string;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS browser_frames (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tool_use_id TEXT,
  tool TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  picture TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_frames_conversation ON browser_frames (conversation_id, id);
`;

/** How many a conversation keeps; the oldest go first. */
const KEEP_PER_CONVERSATION = 150;

interface Row {
  id: number;
  conversation_id: string;
  tool_use_id: string | null;
  tool: string;
  created_at: number;
}

function toRecord(row: Row): BrowserFrameRecord {
  return { id: row.id, conversationId: row.conversation_id, toolUseId: row.tool_use_id, tool: row.tool, createdAt: row.created_at };
}

export class FrameStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  /** Keep one picture (base64 JPEG) for a step; the conversation's oldest are let go past the cap. */
  add(input: { conversationId: string; toolUseId?: string; tool: string; picture: string }): BrowserFrameRecord {
    const info = this.db
      .prepare(`INSERT INTO browser_frames (conversation_id, tool_use_id, tool, created_at, picture) VALUES (?, ?, ?, ?, ?)`)
      .run(input.conversationId, input.toolUseId ?? null, input.tool, this.now(), input.picture);
    this.db
      .prepare(
        `DELETE FROM browser_frames WHERE conversation_id = ? AND id NOT IN (
           SELECT id FROM browser_frames WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(input.conversationId, input.conversationId, KEEP_PER_CONVERSATION);
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): BrowserFrameRecord | undefined {
    const row = this.db.prepare(`SELECT id, conversation_id, tool_use_id, tool, created_at FROM browser_frames WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** The picture itself, base64 JPEG. */
  pictureOf(id: number): string | undefined {
    const row = this.db.prepare(`SELECT picture FROM browser_frames WHERE id = ?`).get(id) as { picture: string } | undefined;
    return row?.picture;
  }

  /** A conversation's frames, oldest first, without their pictures. */
  listFor(conversationId: string): BrowserFrameRecord[] {
    const rows = this.db.prepare(`SELECT id, conversation_id, tool_use_id, tool, created_at FROM browser_frames WHERE conversation_id = ? ORDER BY id`).all(conversationId) as Row[];
    return rows.map(toRecord);
  }

  /** Frame id by the tool call it followed, for a conversation's transcript. */
  byToolUse(conversationId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const f of this.listFor(conversationId)) if (f.toolUseId) out.set(f.toolUseId, f.id);
    return out;
  }
}
