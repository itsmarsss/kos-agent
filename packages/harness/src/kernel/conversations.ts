import type { Db } from "../store/db.js";

/**
 * Named, parallel conversations.
 *
 * A conversation id doubles as the transcript's session id, so this table is
 * metadata over the existing chat_sessions rows rather than a second copy of
 * the messages. Every surface reads the same list: a conversation started in
 * Discord is the same object the dashboard shows, because the concept lives in
 * the kernel and channels only point at it.
 */

export interface Conversation {
  /** Stable id, and the session id its transcript is stored under. */
  id: string;
  userId: string;
  title: string;
  /** Where it was started, for display only. */
  channel: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /**
   * Extra instructions for this conversation only, appended to the system
   * prompt. This is what makes one conversation a different agent from
   * another rather than the same assistant under a different title.
   */
  brief: string | null;
  /**
   * Hard allow-list of tool name prefixes.
   *
   * null means unrestricted: the full toolkit. An array is an exact scope, and
   * an empty array really does mean no tools at all. Collapsing those two onto
   * "empty" made "give this conversation nothing" impossible to express.
   */
  toolAllow: string[] | null;
  /**
   * The project this conversation belongs to, when it belongs to one.
   *
   * A project orchestrator carries its own slug; an agent it starts inherits
   * it. The slug scopes the chats tools and, later, keys remembered
   * permissions. Null is the root: KOS itself and plain chats.
   */
  projectSlug: string | null;
  /**
   * When the owner last looked at this thread, on any surface. Null until
   * they have. Newer activity than this is unread, which is what the chat
   * list's green dot means.
   */
  readAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations (user_id, updated_at DESC);

-- Which conversation a given surface is currently pointed at. A surface with
-- native threads never needs this; a plain DM does, because there is only one
-- stream of messages and the user switches with a command.
CREATE TABLE IF NOT EXISTS conversation_active (
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  PRIMARY KEY (channel, user_id)
);
`;

interface Row {
  id: string;
  user_id: string;
  title: string;
  channel: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
  brief: string | null;
  tool_allow: string | null;
  project_slug?: string | null;
  read_at?: number | null;
}

function toConversation(row: Row): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    channel: row.channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    brief: row.brief ?? null,
    toolAllow: parseAllow(row.tool_allow),
    projectSlug: row.project_slug ?? null,
    readAt: row.read_at ?? null,
  };
}

/**
 * Stored as JSON, or SQL NULL for unrestricted. Malformed JSON reads as
 * unrestricted rather than as "no tools": failing open on a display bug is
 * recoverable, silently muting a conversation is not.
 */
function parseAllow(raw: string | null): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

const MAX_TITLE = 60;

/**
 * A title from the opening message. Deterministic and free: an LLM pass would
 * cost a call on every new conversation, and the user can rename.
 */
export function titleFromText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return "New conversation";
  if (line.length <= MAX_TITLE) return line;
  const cut = line.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface CreateConversationInput {
  userId: string;
  brief?: string;
  toolAllow?: string[] | null;
  projectSlug?: string | null;
  /** Omit to use a placeholder until the first message names it. */
  title?: string;
  channel?: string;
  /** Explicit id; otherwise one is derived from the clock and a counter. */
  id?: string;
}

/**
 * What sort of thread this is.
 *
 * Three of the four are not conversations the owner started, and none of
 * those three is theirs to rename, archive or delete: the router is what KOS
 * is, a surface's stream is where a channel talks and would simply be remade
 * on the next message, and a job's thread is the record of its runs. They
 * were protected by not being shown, which is not the same as protected --
 * the endpoints took any id at all.
 */
export type ConversationKind = "orchestrator" | "project" | "surface" | "schedule" | "chat";

/** The id of a project's own orchestrator: one per project, like `cron:<id>`. */
export function projectConversationId(slug: string): string {
  return `project:${slug}`;
}

export function conversationKind(
  conversation: Pick<Conversation, "id" | "channel">,
  ownerId: string,
): ConversationKind {
  if (conversation.id === `orchestrator:${ownerId}`) return "orchestrator";
  if (conversation.id.startsWith("project:")) return "project";
  if (conversation.id.startsWith("cron:")) return "schedule";
  // A surface's own stream is the channel's name and the owner's. A thread
  // on a surface that has them is `channel:threadId`, which is not this.
  if (conversation.channel && conversation.id === `${conversation.channel}:${ownerId}`) {
    return "surface";
  }
  return "chat";
}

/** Threads the owner cannot rename, archive or delete. */
export function isFixed(
  conversation: Pick<Conversation, "id" | "channel">,
  ownerId: string,
): boolean {
  return conversationKind(conversation, ownerId) !== "chat";
}

export class ConversationStore {
  private counter = 0;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
    // Workspaces created before agent briefs existed get the columns added in
    // place rather than a migration step the owner has to run.
    const columns = this.db
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as { name: string }[];
    const has = (n: string): boolean => columns.some((c) => c.name === n);
    if (!has("brief")) this.db.exec(`ALTER TABLE conversations ADD COLUMN brief TEXT`);
    if (!has("tool_allow")) {
      this.db.exec(`ALTER TABLE conversations ADD COLUMN tool_allow TEXT`);
    }
    if (!has("project_slug")) {
      this.db.exec(`ALTER TABLE conversations ADD COLUMN project_slug TEXT`);
    }
    if (!has("read_at")) {
      // Backfilled as read: what was there before the column counts as
      // seen, so the upgrade does not light every thread green at once.
      this.db.exec(`ALTER TABLE conversations ADD COLUMN read_at INTEGER`);
      this.db.exec(`UPDATE conversations SET read_at = updated_at WHERE read_at IS NULL`);
    }
  }

  /** Ids are readable and sortable; uniqueness is enforced by the primary key. */
  private nextId(userId: string): string {
    for (;;) {
      this.counter += 1;
      const id = `c${this.now().toString(36)}${this.counter.toString(36)}:${userId}`;
      if (!this.get(id)) return id;
    }
  }

  create(input: CreateConversationInput): Conversation {
    const ts = this.now();
    const id = input.id ?? this.nextId(input.userId);
    const row: Conversation = {
      id,
      userId: input.userId,
      title: input.title?.trim() || "New conversation",
      channel: input.channel ?? null,
      createdAt: ts,
      updatedAt: ts,
      archived: false,
      brief: input.brief?.trim() || null,
      toolAllow: input.toolAllow ?? null,
      projectSlug: input.projectSlug ?? null,
      readAt: null,
    };
    const { readAt: _unread, ...columns } = row;
    this.db
      .prepare(
        `INSERT INTO conversations (id, user_id, title, channel, created_at, updated_at, archived, brief, tool_allow, project_slug)
         VALUES (@id, @userId, @title, @channel, @createdAt, @updatedAt, 0, @brief, @toolAllow, @projectSlug)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        ...columns,
        toolAllow: row.toolAllow === null ? null : JSON.stringify(row.toolAllow),
      });
    return this.get(id) ?? row;
  }

  get(id: string): Conversation | undefined {
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toConversation(row) : undefined;
  }

  list(userId: string, options: { includeArchived?: boolean } = {}): Conversation[] {
    // rowid breaks ties: two conversations started in the same millisecond
    // would otherwise come back in whatever order SQLite felt like, and the
    // positions people type into /switch have to be stable.
    const sql = options.includeArchived
      ? `SELECT * FROM conversations WHERE user_id = ?
         ORDER BY updated_at DESC, rowid DESC`
      : `SELECT * FROM conversations WHERE user_id = ? AND archived = 0
         ORDER BY updated_at DESC, rowid DESC`;
    return (this.db.prepare(sql).all(userId) as Row[]).map(toConversation);
  }

  /** Give a conversation (or replace) its standing brief. */
  setBrief(id: string, brief: string): Conversation | undefined {
    this.db.prepare(`UPDATE conversations SET brief = ?, updated_at = ? WHERE id = ?`).run(brief.trim() || null, this.now(), id);
    return this.get(id);
  }

  rename(id: string, title: string): Conversation | undefined {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
    if (clean === "") return this.get(id);
    this.db
      .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
      .run(clean, this.now(), id);
    return this.get(id);
  }

  /** Bump ordering, and adopt a title if the conversation is still unnamed. */
  /** The owner has seen this thread as it is now. */
  markRead(id: string): void {
    this.db.prepare(`UPDATE conversations SET read_at = ? WHERE id = ?`).run(this.now(), id);
  }

  touch(id: string, firstText?: string): void {
    const current = this.get(id);
    if (!current) return;
    const title =
      current.title === "New conversation" && firstText
        ? titleFromText(firstText)
        : current.title;
    this.db
      .prepare(`UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?`)
      .run(this.now(), title, id);
  }

  /** Change what this conversation is for, or what it may reach. */
  configure(
    id: string,
    config: { brief?: string | null; toolAllow?: string[] | null },
  ): Conversation | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const brief =
      config.brief === undefined ? current.brief : config.brief?.trim() || null;
    // undefined leaves it alone; null clears the scope; an array sets it.
    const allow =
      config.toolAllow === undefined ? current.toolAllow : config.toolAllow;
    this.db
      .prepare(
        `UPDATE conversations SET brief = ?, tool_allow = ?, updated_at = ? WHERE id = ?`,
      )
      .run(brief, allow === null ? null : JSON.stringify(allow), this.now(), id);
    return this.get(id);
  }

  /** Put a conversation under a project, or take it out of one. */
  moveToProject(id: string, projectSlug: string | null): Conversation | undefined {
    this.db
      .prepare(`UPDATE conversations SET project_slug = ?, updated_at = ? WHERE id = ?`)
      .run(projectSlug, this.now(), id);
    return this.get(id);
  }

  setArchived(id: string, archived: boolean): Conversation | undefined {
    this.db
      .prepare(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? 1 : 0, this.now(), id);
    return this.get(id);
  }

  /**
   * Remove the conversation and its transcript together, so deleting a
   * conversation cannot leave its messages behind as an orphan.
   *
   * The transcript table belongs to SessionStore, which may not have been
   * constructed on this connection yet, so its absence is a no-op rather than
   * an error.
   */
  remove(id: string): boolean {
    if (this.hasTable("chat_sessions")) {
      this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
    }
    this.db.prepare(`DELETE FROM conversation_active WHERE conversation_id = ?`).run(id);
    const info = this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  private hasTable(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) as { ok: number } | undefined;
    return row !== undefined;
  }

  /** The conversation a surface is pointed at, if it has been set. */
  activeFor(channel: string, userId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT conversation_id FROM conversation_active WHERE channel = ? AND user_id = ?`,
      )
      .get(channel, userId) as { conversation_id: string } | undefined;
    if (!row) return undefined;
    // A pointer at a deleted conversation is stale, not an answer.
    return this.get(row.conversation_id) ? row.conversation_id : undefined;
  }

  /**
   * Forget where a surface was pointed.
   *
   * Used once, to retire pointers set when a surface had no thread of its
   * own: they name whatever the old fallback happened to pick, and left in
   * place they keep winning over the surface's own stream forever.
   */
  clearActive(channel?: string): number {
    const result = channel
      ? this.db
          .prepare(`DELETE FROM conversation_active WHERE channel = ?`)
          .run(channel)
      : this.db.prepare(`DELETE FROM conversation_active`).run();
    return Number(result.changes ?? 0);
  }

  setActive(channel: string, userId: string, conversationId: string): void {
    this.db
      .prepare(
        `INSERT INTO conversation_active (channel, user_id, conversation_id)
         VALUES (?, ?, ?)
         ON CONFLICT(channel, user_id) DO UPDATE SET conversation_id = excluded.conversation_id`,
      )
      .run(channel, userId, conversationId);
  }
}
