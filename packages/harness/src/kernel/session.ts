import type { Db } from "../store/db.js";
import type { ContentBlock, ModelMessage } from "../models/types.js";

/**
 * Durable multi-turn chat sessions. Each channel/user pair has a session id;
 * history is stored as JSON message arrays so the agent loop can re-enter with
 * the full prior context, including the tool calls it made and what they
 * returned.
 *
 * Tool blocks are kept, not stripped: without them a follow-up turn has no
 * record of the slugs, ids, and query results the agent just produced, and it
 * re-derives or invents them. Bloat is controlled by capping oversized
 * tool_result payloads and by dropping whole exchanges from the front, never by
 * discarding the structure of a turn.
 */

/** Shared multi-modal session for the owner (CLI, Discord, dashboard). */
export function primarySessionId(ownerId = "owner"): string {
  return `primary:${ownerId}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface SessionStoreOptions {
  /** Approximate character budget for the whole persisted history. */
  maxChars?: number;
  /** Per-tool_result cap; longer results are truncated with a marker. */
  maxToolResultChars?: number;
  /** Hard ceiling on retained exchanges regardless of size. */
  maxExchanges?: number;
}

const DEFAULT_MAX_CHARS = 48_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 4_000;
const DEFAULT_MAX_EXCHANGES = 12;

/**
 * True when a user message is purely the tool_result half of an exchange
 * rather than something the owner actually said. Those can never begin a
 * history: an orphaned tool_result with no preceding tool_use is a protocol
 * error on every provider.
 */
function isToolResultOnly(message: ModelMessage): boolean {
  return (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((b) => b.type === "tool_result")
  );
}

/** Start of a real owner turn: the boundary we are allowed to truncate at. */
function startsExchange(message: ModelMessage): boolean {
  return message.role === "user" && !isToolResultOnly(message);
}

/**
 * Split a flat message list into exchanges, each beginning with an owner turn
 * and carrying its assistant replies and tool round-trips. Truncating at these
 * boundaries is what keeps every tool_use paired with its tool_result.
 */
function toExchanges(messages: ModelMessage[]): ModelMessage[][] {
  const exchanges: ModelMessage[][] = [];
  for (const message of messages) {
    if (startsExchange(message) || exchanges.length === 0) {
      exchanges.push([message]);
    } else {
      exchanges[exchanges.length - 1]?.push(message);
    }
  }
  // Drop a leading group only when it opens with an orphaned tool_result,
  // which no provider accepts. An assistant message can legitimately come
  // first: a conversation may be seeded with an opening note before the owner
  // has said anything.
  if (exchanges.length > 0 && isToolResultOnly(exchanges[0]![0]!)) {
    exchanges.shift();
  }
  return exchanges;
}

function capBlock(block: ContentBlock, maxToolResultChars: number): ContentBlock {
  if (block.type !== "tool_result") return block;
  if (block.content.length <= maxToolResultChars) return block;
  return {
    ...block,
    content: `${block.content.slice(0, maxToolResultChars)}\n…[truncated ${
      block.content.length - maxToolResultChars
    } chars]`,
  };
}

function capMessage(
  message: ModelMessage,
  maxToolResultChars: number,
): ModelMessage {
  if (!message.content.some((b) => b.type === "tool_result")) return message;
  return {
    ...message,
    content: message.content.map((b) => capBlock(b, maxToolResultChars)),
  };
}

/** What the owner may change about retention, all optional. */
export const RETENTION_KEY = "session.retention";

/** The retention in force, as the settings page shows it. */
export interface Retention {
  maxChars: number;
  maxToolResultChars: number;
  maxExchanges: number;
}

export const RETENTION_DEFAULTS: Retention = {
  maxChars: DEFAULT_MAX_CHARS,
  maxToolResultChars: DEFAULT_MAX_TOOL_RESULT_CHARS,
  maxExchanges: DEFAULT_MAX_EXCHANGES,
};

export class SessionStore {
  private maxChars: number;
  private maxToolResultChars: number;
  private maxExchanges: number;

  constructor(
    private readonly db: Db,
    options: SessionStoreOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxToolResultChars =
      options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.maxExchanges = options.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  }

  /** What is in force now. */
  retention(): Retention {
    return {
      maxChars: this.maxChars,
      maxToolResultChars: this.maxToolResultChars,
      maxExchanges: this.maxExchanges,
    };
  }

  /**
   * Change how much history is kept, without a restart.
   *
   * Applied to the next trim rather than retroactively: shrinking the budget
   * should not reach back and delete what is already in a conversation, which
   * would be a settings change that silently destroyed data.
   */
  configure(options: SessionStoreOptions): void {
    if (options.maxChars !== undefined) this.maxChars = options.maxChars;
    if (options.maxToolResultChars !== undefined) {
      this.maxToolResultChars = options.maxToolResultChars;
    }
    if (options.maxExchanges !== undefined) this.maxExchanges = options.maxExchanges;
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

  /**
   * Trim a history to the retention budget: cap oversized tool results, then
   * keep the most recent whole exchanges that fit. Always keeps at least the
   * latest exchange so a single large turn is never erased entirely.
   */
  private trim(messages: ModelMessage[]): ModelMessage[] {
    const capped = messages.map((m) => capMessage(m, this.maxToolResultChars));
    const exchanges = toExchanges(capped);
    if (exchanges.length === 0) return [];

    const kept: ModelMessage[][] = [];
    let total = 0;
    for (let i = exchanges.length - 1; i >= 0; i--) {
      const exchange = exchanges[i]!;
      const size = JSON.stringify(exchange).length;
      const wouldExceed = total + size > this.maxChars;
      if (kept.length > 0 && (wouldExceed || kept.length >= this.maxExchanges)) {
        break;
      }
      kept.unshift(exchange);
      total += size;
    }
    return kept.flat();
  }

  /** Replace the full history, trimmed to the retention budget. */
  set(sessionId: string, messages: ModelMessage[]): void {
    const trimmed = this.trim(messages);
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
   * Persist the conversation as the agent loop left it. `messages` is the loop's
   * full message list (prior history plus this turn's tool round-trips and
   * final reply), so tool context survives into the next turn.
   */
  record(sessionId: string, messages: ModelMessage[]): ModelMessage[] {
    const trimmed = this.trim(messages);
    this.set(sessionId, trimmed);
    return trimmed;
  }

  /** History to feed the model: prior turns only (caller adds the new user msg). */
  historyForPrompt(sessionId: string): ModelMessage[] {
    return this.get(sessionId);
  }

  clear(sessionId: string): void {
    this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(sessionId);
  }
}
