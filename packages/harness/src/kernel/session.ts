import type { Db } from "../store/db.js";
import type { ModelMessage } from "../models/types.js";

/**
 * Durable multi-turn chat sessions. Each channel/user pair has a session id;
 * history is stored as JSON message arrays and truncated to a turn budget so
 * the agent loop can re-enter with prior context without dumping forever.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface SessionStoreOptions {
  /** Max ModelMessage entries kept (user + assistant pairs count as 2). */
  maxMessages?: number;
}

export class SessionStore {
  private readonly maxMessages: number;

  constructor(
    private readonly db: Db,
    options: SessionStoreOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    this.maxMessages = options.maxMessages ?? 24;
  }

  get(sessionId: string): ModelMessage[] {
    const row = this.db
      .prepare(`SELECT messages_json FROM chat_sessions WHERE id = ?`)
      .get(sessionId) as { messages_json: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.messages_json) as ModelMessage[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Replace the full history (already truncated by caller if needed). */
  set(sessionId: string, messages: ModelMessage[]): void {
    const trimmed = messages.slice(-this.maxMessages);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, messages_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           messages_json = excluded.messages_json,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(trimmed), ts);
  }

  /**
   * Append a user message and the resulting assistant text (and optional tool
   * turns already in `assistantMessages`). Returns the full history for the
   * next model call.
   */
  appendTurn(
    sessionId: string,
    userText: string,
    assistantMessages: ModelMessage[],
  ): ModelMessage[] {
    const prior = this.get(sessionId);
    // Persist compact turns (text only) so tool_use blocks do not bloat re-entry.
    const compact: ModelMessage[] = [
      ...prior,
      { role: "user", content: [{ type: "text", text: userText }] },
    ];
    const lastAssistant = [...assistantMessages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (lastAssistant) {
      const text = lastAssistant.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");
      compact.push({
        role: "assistant",
        content: [{ type: "text", text: text || "(done)" }],
      });
    }
    this.set(sessionId, compact);
    return compact;
  }

  /** History to feed the model: prior turns only (caller adds the new user msg). */
  historyForPrompt(sessionId: string): ModelMessage[] {
    return this.get(sessionId);
  }

  clear(sessionId: string): void {
    this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(sessionId);
  }
}
