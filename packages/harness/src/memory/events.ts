import * as sqliteVec from "sqlite-vec";

import type { Db } from "../store/db.js";

/**
 * The events log: what happened, kept.
 *
 * Every message in and out is a row, with who said it and where. Nothing
 * is deleted: compaction marks rows shadowed so they leave the model's
 * context and stay here, where "what did we say about X in March" can be
 * answered. Searchable two ways at once, by words (FTS5) and by meaning
 * (sqlite-vec), fused so a hit on either counts and a hit on both counts
 * more. This is the ground truth the rest of memory is derived from.
 */

export type EventRole = "owner" | "agent" | "system" | "tool";
/** How far the text can be trusted to be the owner's own view of the world. */
export type EventTrust = "owner" | "agent" | "tool" | "external";

export interface MemoryEvent {
  id: number;
  ts: number;
  userId: string;
  conversationId: string | null;
  projectSlug: string | null;
  /** Which harness wrote it: kos, or a caller's own name. */
  caller: string;
  role: EventRole;
  /** message, exchange (a legacy pair), tool_call, tool_result, note. */
  kind: string;
  text: string;
  trust: EventTrust;
  /** Out of the model's context, still in the log. */
  shadowed: boolean;
}

export interface EventHit extends MemoryEvent {
  /** Fused rank score; larger is better. Comparable only within one search. */
  score: number;
}

export interface NewEvent {
  userId: string;
  conversationId?: string | null;
  projectSlug?: string | null;
  caller?: string;
  role: EventRole;
  kind?: string;
  text: string;
  trust?: EventTrust;
}

export interface EventSearch {
  userId: string;
  /** Words to match. Either this or an embedding, usually both. */
  query?: string;
  embedding?: number[];
  k?: number;
  /** Hits from this project rank a little higher than the rest. */
  projectSlug?: string | null;
  /** Only this conversation. */
  conversationId?: string;
  includeShadowed?: boolean;
}

interface Row {
  id: number;
  ts: number;
  user_id: string;
  conversation_id: string | null;
  project_slug: string | null;
  caller: string;
  role: string;
  kind: string;
  text: string;
  trust: string;
  shadowed: number;
  provider: string | null;
}

const RRF_K = 60;

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** A query the FTS engine will not choke on: each word quoted, any of them matching. */
export function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  const unique = [...new Set(words)].slice(0, 24);
  if (unique.length === 0) return null;
  return unique.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

export class EventLog {
  private readonly vecTable: string;

  constructor(
    private readonly db: Db,
    readonly dimension: number,
    private readonly now: () => number = Date.now,
    /** Which embedder made the vectors; another provider's are not comparable. */
    private readonly provider: string = "unknown",
  ) {
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_log (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        conversation_id TEXT,
        project_slug TEXT,
        caller TEXT NOT NULL DEFAULT 'kos',
        role TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'message',
        text TEXT NOT NULL,
        trust TEXT NOT NULL DEFAULT 'owner',
        shadowed INTEGER NOT NULL DEFAULT 0,
        provider TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_log_conversation ON memory_log (conversation_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_log_fts USING fts5(text, content='memory_log', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS memory_log_ai AFTER INSERT ON memory_log BEGIN
        INSERT INTO memory_log_fts (rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_log_au AFTER UPDATE OF text ON memory_log BEGIN
        INSERT INTO memory_log_fts (memory_log_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO memory_log_fts (rowid, text) VALUES (new.id, new.text);
      END;
    `);
    this.vecTable = `memory_logvec_${dimension}`;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTable} USING vec0(embedding float[${dimension}])`);
    this.migrateEpisodes();
  }

  /**
   * Older workspaces kept exchanges in memory_events with their vectors in
   * memory_vec_<dim>. They are the first events in the log, copied once;
   * the old tables are left for the git snapshot to keep.
   */
  private migrateEpisodes(): void {
    const has = (table: string): boolean =>
      this.db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(table) !== undefined;
    if (!has("memory_events")) return;
    const filled = (this.db.prepare(`SELECT count(*) AS n FROM memory_log`).get() as { n: number }).n > 0;
    if (filled) return;
    const old = this.db
      .prepare(`SELECT id, user_id, text, created_at, provider FROM memory_events ORDER BY id`)
      .all() as { id: number; user_id: string; text: string; created_at: number; provider: string | null }[];
    if (old.length === 0) return;
    const oldVec = `memory_vec_${this.dimension}`;
    const vectors = has(oldVec) ? this.db.prepare(`SELECT embedding FROM ${oldVec} WHERE rowid = ?`) : null;
    const insert = this.db.prepare(
      `INSERT INTO memory_log (ts, user_id, conversation_id, project_slug, caller, role, kind, text, trust, shadowed, provider)
       VALUES (?, ?, NULL, NULL, 'kos', 'owner', 'exchange', ?, 'owner', 0, ?)`,
    );
    const insertVec = this.db.prepare(`INSERT INTO ${this.vecTable} (rowid, embedding) VALUES (?, ?)`);
    this.db.transaction(() => {
      for (const row of old) {
        const id = Number(insert.run(row.created_at, row.user_id, row.text, row.provider).lastInsertRowid);
        const vec = vectors?.get(BigInt(row.id)) as { embedding: Buffer } | undefined;
        if (vec && (row.provider == null || row.provider === this.provider)) insertVec.run(BigInt(id), vec.embedding);
      }
    })();
  }

  append(event: NewEvent, embedding?: number[]): number {
    if (embedding) this.assertDimension(embedding);
    const info = this.db
      .prepare(
        `INSERT INTO memory_log (ts, user_id, conversation_id, project_slug, caller, role, kind, text, trust, shadowed, provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        this.now(),
        event.userId,
        event.conversationId ?? null,
        event.projectSlug ?? null,
        event.caller ?? "kos",
        event.role,
        event.kind ?? "message",
        event.text,
        event.trust ?? (event.role === "owner" ? "owner" : event.role === "agent" ? "agent" : "tool"),
        embedding ? this.provider : null,
      );
    const id = Number(info.lastInsertRowid);
    if (embedding) {
      this.db.prepare(`INSERT INTO ${this.vecTable} (rowid, embedding) VALUES (?, ?)`).run(BigInt(id), toBlob(embedding));
    }
    return id;
  }

  get(id: number): MemoryEvent | undefined {
    const row = this.db.prepare(`SELECT * FROM memory_log WHERE id = ?`).get(id) as Row | undefined;
    return row ? toEvent(row) : undefined;
  }

  count(userId: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM memory_log WHERE user_id = ?`).get(userId) as { n: number }).n;
  }

  /** Take events out of the model's context. They stay in the log and in search. */
  shadow(ids: number[]): void {
    const stmt = this.db.prepare(`UPDATE memory_log SET shadowed = 1 WHERE id = ?`);
    this.db.transaction(() => { for (const id of ids) stmt.run(id); })();
  }

  /**
   * Blank the text of events the owner asked to forget. The rows stay, so
   * the conversation's shape and timing survive, but the words are gone
   * from the text, the index and the vectors alike.
   */
  redact(ids: number[]): void {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db.prepare(`UPDATE memory_log SET text = '[forgotten]', provider = NULL WHERE id IN (${marks})`).run(...ids);
      this.db.prepare(`DELETE FROM ${this.vecTable} WHERE rowid IN (${marks})`).run(...ids.map((i) => BigInt(i)));
    })();
  }

  /**
   * Events after a watermark, oldest first: what the extractor has not read.
   * What people said, the owner's, KOS's, or a caller's; tool output never
   * becomes memory on its own, and a forgotten event has nothing left to
   * read. A caller's words carry external trust, and a reader keeps that.
   */
  since(userId: string, afterId: number, limit = 500): MemoryEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_log WHERE user_id = ? AND id > ? AND role IN ('owner', 'agent') AND trust IN ('owner', 'agent', 'external') AND text <> '[forgotten]'
         ORDER BY id LIMIT ?`,
      )
      .all(userId, afterId, limit) as Row[];
    return rows.map(toEvent);
  }

  /** The newest events anywhere, newest first. */
  latest(userId: string, limit = 50): MemoryEvent[] {
    return (this.db.prepare(`SELECT * FROM memory_log WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit) as Row[]).map(toEvent);
  }

  /** The newest events in a conversation, oldest first. */
  recent(conversationId: string, limit = 50): MemoryEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_log WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
      .all(conversationId, limit) as Row[];
    return rows.reverse().map(toEvent);
  }

  /**
   * Hybrid search: words and meaning, fused by reciprocal rank so a hit
   * on both lists outranks a hit on one. Same-project events get a
   * nudge; nothing is excluded for being elsewhere, since memory is one.
   */
  search(opts: EventSearch): EventHit[] {
    const k = opts.k ?? 5;
    const pool = Math.max(k * 4, 20);
    const scores = new Map<number, number>();
    const add = (ids: number[]): void => {
      ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    };
    const match = opts.query ? ftsQuery(opts.query) : null;
    if (match) {
      const rows = this.db
        .prepare(
          `SELECT l.id AS id FROM memory_log_fts f JOIN memory_log l ON l.id = f.rowid
           WHERE memory_log_fts MATCH ? AND l.user_id = ? ${opts.includeShadowed ? "" : ""}
           ${opts.conversationId ? "AND l.conversation_id = ?" : ""}
           ORDER BY bm25(memory_log_fts) LIMIT ?`,
        )
        .all(...[match, opts.userId, ...(opts.conversationId ? [opts.conversationId] : []), pool]) as { id: number }[];
      add(rows.map((r) => r.id));
    }
    if (opts.embedding) {
      this.assertDimension(opts.embedding);
      const candidates = this.db
        .prepare(`SELECT rowid AS id, distance FROM ${this.vecTable} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
        .all(toBlob(opts.embedding), pool * 2) as { id: number; distance: number }[];
      const ids: number[] = [];
      const check = this.db.prepare(`SELECT user_id, conversation_id, provider FROM memory_log WHERE id = ?`);
      for (const c of candidates) {
        const row = check.get(c.id) as { user_id: string; conversation_id: string | null; provider: string | null } | undefined;
        if (!row || row.user_id !== opts.userId) continue;
        if (row.provider != null && row.provider !== this.provider) continue;
        if (opts.conversationId && row.conversation_id !== opts.conversationId) continue;
        ids.push(c.id);
        if (ids.length >= pool) break;
      }
      add(ids);
    }
    if (scores.size === 0) return [];
    const get = this.db.prepare(`SELECT * FROM memory_log WHERE id = ?`);
    const hits: EventHit[] = [];
    for (const [id, base] of scores) {
      const row = get.get(id) as Row | undefined;
      if (!row) continue;
      const event = toEvent(row);
      const boost = opts.projectSlug && event.projectSlug === opts.projectSlug ? 1.25 : 1;
      hits.push({ ...event, score: base * boost });
    }
    hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
    return hits.slice(0, k);
  }

  private assertDimension(embedding: number[]): void {
    if (embedding.length !== this.dimension) {
      throw new Error(`embedding dimension ${embedding.length} does not match store dimension ${this.dimension}`);
    }
  }
}

function toEvent(row: Row): MemoryEvent {
  return {
    id: row.id,
    ts: row.ts,
    userId: row.user_id,
    conversationId: row.conversation_id,
    projectSlug: row.project_slug,
    caller: row.caller,
    role: row.role as EventRole,
    kind: row.kind,
    text: row.text,
    trust: row.trust as EventTrust,
    shadowed: row.shadowed === 1,
  };
}
