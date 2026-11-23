import type { Db } from "../store/db.js";
import type { ContentBlock, ModelMessage } from "../models/types.js";
import { withoutPictures } from "../agent/pictures.js";

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
CREATE TABLE IF NOT EXISTS chat_session_earlier (
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  why TEXT NOT NULL,
  messages_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_session_earlier_id ON chat_session_earlier (id, at);
`;

/**
 * Why a stretch of a chat was set aside: the owner cleared it, it was folded
 * into a summary, or it fell out of what KOS keeps (the oldest exchanges past
 * the retention budget), kept for the owner to read all the same.
 */
export type EarlierWhy = "cleared" | "compacted" | "trimmed";

/** A stretch of a chat set aside: what was said, when it was set aside, and why. */
export interface EarlierHistory {
  at: number;
  why: EarlierWhy;
  messages: ModelMessage[];
}

function earlierWhy(why: string): EarlierWhy {
  return why === "compacted" || why === "trimmed" ? why : "cleared";
}

/** Stretches kept per chat; past this the oldest goes. */
const EARLIER_MAX = 8;

export interface SessionStoreOptions {
  /**
   * Whether to trim at all.
   *
   * Separate from the budgets so turning it off and back on does not mean
   * remembering what the numbers were. Off keeps everything, at the owner's
   * cost: an untrimmed history grows without bound and is re-sent every turn.
   */
  autoTrim?: boolean;
  /** Told when a trim actually drops something, so it is not silent. */
  onTrimmed?: (dropped: number, kept: number) => void;
  /** Approximate character budget for the whole persisted history. */
  maxChars?: number;
  /** Per-tool_result cap; longer results are truncated with a marker. */
  maxToolResultChars?: number;
  /** Hard ceiling on retained exchanges regardless of size. */
  maxExchanges?: number;
}

// Room for a real working conversation rather than a few questions. The old
// 48k/12 dropped the start of a session that had done any tool work in it,
// which is where the owner said what they actually wanted.
const DEFAULT_MAX_CHARS = 128_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 4_000;
const DEFAULT_MAX_EXCHANGES = 36;

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
export function toExchanges(messages: ModelMessage[]): ModelMessage[][] {
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

/**
 * What a picture costs the retention budget, in characters: about the 1,600
 * tokens a provider bills one near its largest size, at four characters a
 * token. Its base64 was counted as text, so one 160 KB photo read as 216,804
 * characters of a 128,000 budget: the meter said full and the oldest turns
 * were trimmed for it.
 */
export const PICTURE_CHARS = 6_400;

/** The pictures in messages: attached, and come back with a tool's result. */
export function picturesIn(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) for (const b of m.content) n += b.type === "image" ? 1 : b.type === "tool_result" ? (b.images?.length ?? 0) : 0;
  return n;
}

/** A message with its pictures' bytes left out, for counting what its words take. */
function wordsOf({ at: _at, ...message }: ModelMessage): Omit<ModelMessage, "at"> {
  if (!message.content.some((b) => b.type === "image" || (b.type === "tool_result" && b.images?.length))) return message;
  return {
    ...message,
    content: message.content.map((b) => (b.type === "image" ? { ...b, data: "" } : b.type === "tool_result" && b.images ? { ...b, images: b.images.map((i) => ({ ...i, data: "" })) } : b)),
  };
}

/**
 * How much of the retention budget messages take: their JSON, without when
 * each was said, which is the reader's and never sent to the model, so a
 * time does not cost a turn its place, and with each picture at its
 * allowance rather than its bytes.
 */
export function historySize(messages: ModelMessage[]): number {
  return JSON.stringify(messages.map(wordsOf)).length + picturesIn(messages) * PICTURE_CHARS;
}

/** A stored message from before messages kept their time: 0, so it is never taken for a new one. */
function untimed(message: ModelMessage): ModelMessage {
  return message.at === undefined ? { ...message, at: 0 } : message;
}

/** What the owner may change about retention, all optional. */
export const RETENTION_KEY = "session.retention";

/** The retention in force, as the settings page shows it. */
export interface Retention {
  maxChars: number;
  maxToolResultChars: number;
  maxExchanges: number;
  autoTrim: boolean;
}

/**
 * The conversation a scheduled job runs in.
 *
 * A job used to call the model directly, with no conversation, so a run left
 * no transcript, no live view and nothing to ask about afterwards: the only
 * record was a row saying it succeeded. Runs land in a thread of the job's
 * own now, so watching one, asking it what it is doing, and reading last
 * week's are the things the chat view already does.
 */
export function cronSessionId(jobId: number): string {
  return `cron:${jobId}`;
}

/**
 * The one chat KOS's upkeep (kos.backup, kos.memory and the rest) tells of
 * a failure in, rather than a thread per job: on a server, one thread under
 * KOS's own channel.
 */
export function upkeepSessionId(ownerId: string): string {
  return `upkeep:${ownerId}`;
}

export const RETENTION_DEFAULTS: Retention = {
  maxChars: DEFAULT_MAX_CHARS,
  maxToolResultChars: DEFAULT_MAX_TOOL_RESULT_CHARS,
  maxExchanges: DEFAULT_MAX_EXCHANGES,
  autoTrim: true,
};

export class SessionStore {
  private maxChars: number;
  private maxToolResultChars: number;
  private maxExchanges: number;
  private autoTrim: boolean;
  private onTrimmed: ((dropped: number, kept: number) => void) | undefined;

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
    this.autoTrim = options.autoTrim ?? true;
    this.onTrimmed = options.onTrimmed;
  }

  /** Told when a trim drops something, so the owner can be. */
  watch(onTrimmed: (dropped: number, kept: number) => void): void {
    this.onTrimmed = onTrimmed;
  }

  /** What is in force now. */
  retention(): Retention {
    return {
      maxChars: this.maxChars,
      maxToolResultChars: this.maxToolResultChars,
      maxExchanges: this.maxExchanges,
      autoTrim: this.autoTrim,
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
    if (options.autoTrim !== undefined) this.autoTrim = options.autoTrim;
  }

  get(sessionId: string): ModelMessage[] {
    const row = this.db
      .prepare(`SELECT messages_json FROM chat_sessions WHERE id = ?`)
      .get(sessionId) as { messages_json: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.messages_json) as ModelMessage[];
      return Array.isArray(parsed) ? parsed.map(untimed) : [];
    } catch {
      return [];
    }
  }

  /**
   * The chats whose kept words may hold `word`, now or in a stretch set
   * aside: a cheap first pass over the stored JSON before a search reads
   * each chat in full. Undefined when the word could be spelled otherwise
   * there (escaped in JSON, or a letter SQLite does not lower), so the
   * caller reads every chat instead; never a chat left out that holds it.
   */
  mentioning(word: string): Set<string> | undefined {
    const needle = word.toLowerCase();
    if (needle === "" || !/^[\x20-\x7e]+$/.test(needle) || /["\\/]/.test(needle)) return undefined;
    const rows = this.db
      .prepare(`SELECT id FROM chat_sessions WHERE instr(lower(messages_json), ?) > 0 UNION SELECT id FROM chat_session_earlier WHERE instr(lower(messages_json), ?) > 0`)
      .all(needle, needle) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Each message new to the chat stamped with now. One kept before messages
   * kept their time comes out of get() as 0, so it is never stamped with a
   * later turn's time; one a turn made has no time until it is written here.
   */
  private stamped(messages: ModelMessage[]): ModelMessage[] {
    const now = this.now();
    return messages.map((m) => (m.at === undefined ? { ...m, at: now } : m));
  }

  /**
   * Trim a history to the retention budget: cap oversized tool results, then
   * keep the most recent whole exchanges that fit. Always keeps at least the
   * latest exchange so a single large turn is never erased entirely.
   */
  private trim(sessionId: string, messages: ModelMessage[]): ModelMessage[] {
    /*
     * Zero is off, per budget.
     *
     * There was no way to say "keep everything": the smallest allowed budget
     * was one, so a workspace that wanted its whole history had to guess at a
     * number large enough and hope. Off is a thing the owner can mean, so it
     * is a thing they can say -- at their own cost, since an untrimmed
     * history grows without bound and every turn carries all of it.
     */
    if (!this.autoTrim) return messages;
    const capped = this.maxToolResultChars
      ? messages.map((m) => capMessage(m, this.maxToolResultChars))
      : messages;
    const exchanges = toExchanges(capped);
    if (exchanges.length === 0) return [];

    const kept: ModelMessage[][] = [];
    let total = 0;
    for (let i = exchanges.length - 1; i >= 0; i--) {
      const exchange = exchanges[i]!;
      const size = historySize(exchange);
      const wouldExceed = this.maxChars > 0 && total + size > this.maxChars;
      const tooMany = this.maxExchanges > 0 && kept.length >= this.maxExchanges;
      if (kept.length > 0 && (wouldExceed || tooMany)) break;
      kept.unshift(exchange);
      total += size;
    }
    /*
     * Said out loud when something goes.
     *
     * Trimming was silent, so a conversation quietly lost its early turns and
     * the only sign was the agent no longer knowing something it had been
     * told. The reader can then decide to /compact, or turn trimming off.
     */
    if (kept.length < exchanges.length) {
      this.onTrimmed?.(exchanges.length - kept.length, kept.length);
      this.keepTrimmed(sessionId, exchanges.slice(0, exchanges.length - kept.length).flat());
    }
    return kept.flat();
  }

  /** Persist exactly what it is given. Trimming is the caller's business. */
  private write(sessionId: string, messages: ModelMessage[]): void {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, messages_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           messages_json = excluded.messages_json,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(messages), ts);
  }

  /** Replace the full history, trimmed to the retention budget. */
  set(sessionId: string, messages: ModelMessage[]): void {
    this.write(sessionId, this.trim(sessionId, withoutPictures(this.stamped(messages))));
  }

  /**
   * Persist the conversation as the agent loop left it. `messages` is the loop's
   * full message list (prior history plus this turn's tool round-trips and
   * final reply), so tool context survives into the next turn.
   */
  record(sessionId: string, messages: ModelMessage[]): ModelMessage[] {
    /*
     * Trimmed once, not twice. This went through set(), which trims again --
     * so every turn measured its whole history for size, capped every tool
     * result, and then did the identical work over the result. The second
     * pass could only ever agree with the first.
     */
    const trimmed = this.trim(sessionId, withoutPictures(this.stamped(messages)));
    this.write(sessionId, trimmed);
    return trimmed;
  }

  /**
   * Messages added to the end as they happen, a running turn's steps: each
   * result capped as a record caps it, and nothing trimmed. Trimming the whole
   * history on every step measured it all each time and could tell the owner
   * it was trimmed once a step; the turn's own record at its end trims once.
   */
  append(sessionId: string, messages: ModelMessage[]): void {
    const added = withoutPictures(this.stamped(messages));
    const capped = this.autoTrim && this.maxToolResultChars ? added.map((m) => capMessage(m, this.maxToolResultChars)) : added;
    this.write(sessionId, [...this.get(sessionId), ...capped]);
  }

  /** History to feed the model: prior turns only (caller adds the new user msg). */
  historyForPrompt(sessionId: string): ModelMessage[] {
    return this.get(sessionId);
  }

  /**
   * Set the chat aside rather than drop it: the model's history starts
   * afresh, and what was said stays, under earlier(), for the owner to read
   * above a line. A /clear used to wipe the chat from the dashboard too, and
   * the owner wanted to keep seeing what led up to it.
   */
  clear(sessionId: string, why: EarlierWhy = "cleared"): void {
    this.setAside(sessionId, why);
    this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(sessionId);
  }

  /** Set the chat aside and put these messages in its place: a compaction's summary. */
  replace(sessionId: string, messages: ModelMessage[], why: EarlierWhy): void {
    this.setAside(sessionId, why);
    this.write(sessionId, this.trim(sessionId, withoutPictures(this.stamped(messages))));
  }

  /** What was set aside, oldest first. */
  earlier(sessionId: string): EarlierHistory[] {
    const rows = this.db.prepare(`SELECT at, why, messages_json FROM chat_session_earlier WHERE id = ? ORDER BY at, rowid`).all(sessionId) as {
      at: number;
      why: string;
      messages_json: string;
    }[];
    return rows.flatMap((row) => {
      try {
        const messages = JSON.parse(row.messages_json) as ModelMessage[];
        return Array.isArray(messages) ? [{ at: row.at, why: earlierWhy(row.why), messages }] : [];
      } catch {
        return [];
      }
    });
  }

  private setAside(sessionId: string, why: EarlierWhy): void {
    const current = this.get(sessionId);
    if (current.length === 0) return;
    this.putAside(sessionId, why, current);
  }

  /**
   * What a trim let go, kept for the owner: KOS no longer reads it, the chat
   * still shows it. Trimmed a turn at a time, it joins the stretch trimmed
   * before it rather than drawing a line under every exchange.
   */
  private keepTrimmed(sessionId: string, dropped: ModelMessage[]): void {
    if (dropped.length === 0) return;
    const last = this.db.prepare(`SELECT rowid, why, messages_json FROM chat_session_earlier WHERE id = ? ORDER BY at DESC, rowid DESC LIMIT 1`).get(sessionId) as
      | { rowid: number; why: string; messages_json: string }
      | undefined;
    if (last?.why !== "trimmed") {
      this.putAside(sessionId, "trimmed", dropped);
      return;
    }
    let before: ModelMessage[] = [];
    try {
      const parsed = JSON.parse(last.messages_json) as unknown;
      if (Array.isArray(parsed)) before = parsed as ModelMessage[];
    } catch {
      // A stretch that does not read is started afresh rather than lost with what joins it.
    }
    this.db.prepare(`UPDATE chat_session_earlier SET at = ?, messages_json = ? WHERE rowid = ?`).run(this.now(), JSON.stringify([...before, ...dropped]), last.rowid);
  }

  private putAside(sessionId: string, why: EarlierWhy, messages: ModelMessage[]): void {
    this.db.prepare(`INSERT INTO chat_session_earlier (id, at, why, messages_json) VALUES (?, ?, ?, ?)`).run(sessionId, this.now(), why, JSON.stringify(messages));
    // The oldest stretch goes once there are too many; a chat cleared every
    // day is not a chat whose every day is worth keeping on the page.
    this.db
      .prepare(
        `DELETE FROM chat_session_earlier WHERE id = ? AND rowid NOT IN (SELECT rowid FROM chat_session_earlier WHERE id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
      )
      .run(sessionId, sessionId, EARLIER_MAX);
  }
}
