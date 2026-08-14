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

/**
 * Words carrying no retrieval signal. Kept deliberately short: this filters
 * question scaffolding ("what did I say my X was again"), not vocabulary.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "yours", "was", "were", "are", "did",
  "does", "do", "done", "have", "has", "had", "with", "that", "this", "these",
  "those", "what", "when", "where", "which", "who", "whom", "why", "how",
  "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  "about", "again", "just", "from", "into", "than", "then", "them", "they",
  "there", "here", "some", "any", "all", "not", "but", "our", "out", "get",
  "got", "tell", "told", "say", "said", "please", "thanks", "hey", "now",
]);

const MIN_TOKEN_LENGTH = 3;
const MAX_TOKENS = 12;

/**
 * Split a message into retrieval tokens: lowercase alphanumerics, stopwords
 * and very short words dropped, deduped, capped so one long message cannot
 * match everything.
 */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9][a-z0-9'_-]*/g) ?? [];
  const seen = new Set<string>();
  for (const token of raw) {
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(token)) continue;
    seen.add(token);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen];
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

  /**
   * Keyword search over keys and values: the cheap, exact tier of retrieval.
   *
   * The query is a whole user message, so it is tokenized rather than matched
   * as one substring. Matching the raw sentence with LIKE effectively never
   * hits, which silently empties this tier and pushes every recall onto the
   * vector fallback. Facts are per-user and small, so scoring in code buys
   * better ranking than SQL can express here.
   */
  search(userId: string, query: string, limit = 20): Fact[] {
    const tokens = tokenize(query);
    const all = this.all(userId); // already ordered by updated_at DESC
    if (tokens.length === 0) return all.slice(0, limit);

    const needle = query.trim().toLowerCase();
    const scored: { fact: Fact; score: number }[] = [];
    for (const fact of all) {
      const key = fact.key.toLowerCase();
      const value = fact.value.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        // A hit on the key is a stronger signal than one buried in the value.
        if (key.includes(token)) score += 2;
        else if (value.includes(token)) score += 1;
      }
      // Whole-phrase containment stays the strongest signal when it happens.
      if (needle && (key.includes(needle) || value.includes(needle))) score += 5;
      if (score > 0) scored.push({ fact, score });
    }

    scored.sort(
      (a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt,
    );
    return scored.slice(0, limit).map((s) => s.fact);
  }

  delete(userId: string, key: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM memory_facts WHERE user_id = ? AND key = ?`)
      .run(userId, key);
    return info.changes > 0;
  }
}
