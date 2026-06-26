import type { Db } from "../store/db.js";
import type { CandidateFact, FactKind } from "./salience.js";

export interface Fact {
  id: number;
  userId: string;
  key: string;
  value: string;
  kind: FactKind;
  source: string | null;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_facts (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key)
);
`;

interface Row {
  id: number;
  user_id: string;
  key: string;
  value: string;
  kind: string;
  source: string | null;
  created_at: number;
  updated_at: number;
}

function toFact(row: Row): Fact {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.key,
    value: row.value,
    kind: row.kind as FactKind,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Structured fact and preference store: the cheap, exact tier of memory,
 * consulted first on retrieval before any vector fallback. Facts are keyed per
 * user (multi-user readiness) and upserted by (user, key).
 */
export class FactsStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  upsert(
    userId: string,
    fact: CandidateFact,
    source: string | null = null,
  ): void {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO memory_facts (user_id, key, value, kind, source, created_at, updated_at)
         VALUES (@userId, @key, @value, @kind, @source, @ts, @ts)
         ON CONFLICT (user_id, key) DO UPDATE SET
           value = excluded.value,
           kind = excluded.kind,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run({ userId, key: fact.key, value: fact.value, kind: fact.kind, source, ts });
  }

  get(userId: string, key: string): Fact | undefined {
    const row = this.db
      .prepare(`SELECT * FROM memory_facts WHERE user_id = ? AND key = ?`)
      .get(userId, key) as Row | undefined;
    return row ? toFact(row) : undefined;
  }

  all(userId: string): Fact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_facts WHERE user_id = ? ORDER BY updated_at DESC`,
      )
      .all(userId) as Row[];
    return rows.map(toFact);
  }

  /** Exact/substring search over keys and values (structured-first retrieval). */
  search(userId: string, query: string, limit = 20): Fact[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_facts
         WHERE user_id = ? AND (key LIKE ? OR value LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(userId, like, like, limit) as Row[];
    return rows.map(toFact);
  }

  delete(userId: string, key: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM memory_facts WHERE user_id = ? AND key = ?`)
      .run(userId, key);
    return info.changes > 0;
  }
}
