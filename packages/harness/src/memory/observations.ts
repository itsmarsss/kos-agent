import type { Db } from "../store/db.js";

/**
 * Observations: what a long conversation was about, kept in its place.
 *
 * Compaction used to replace a whole thread with one summary and throw
 * the detail away. An observation is a dated note covering the older part
 * of a thread, written by KOS itself; the recent exchanges stay as they
 * are, the note stands in for the rest, and the events it covers are
 * shadowed in the log rather than deleted, so "what did we say in March"
 * still has an answer.
 */

export interface Observation {
  id: number;
  conversationId: string;
  seq: number;
  text: string;
  /** How many messages the note stood in for. */
  covered: number;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_observations (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  covered INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_observations_conv ON memory_observations (conversation_id, seq);
`;

interface Row {
  id: number;
  conversation_id: string;
  seq: number;
  text: string;
  covered: number;
  created_at: number;
}

export class ObservationStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.db.exec(SCHEMA);
  }

  add(conversationId: string, text: string, covered: number): Observation {
    const seq = ((this.db.prepare(`SELECT max(seq) AS n FROM memory_observations WHERE conversation_id = ?`).get(conversationId) as { n: number | null }).n ?? 0) + 1;
    const info = this.db
      .prepare(`INSERT INTO memory_observations (conversation_id, seq, text, covered, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(conversationId, seq, text, covered, this.now());
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Observation | undefined {
    const r = this.db.prepare(`SELECT * FROM memory_observations WHERE id = ?`).get(id) as Row | undefined;
    return r ? toObservation(r) : undefined;
  }

  list(conversationId: string): Observation[] {
    return (this.db.prepare(`SELECT * FROM memory_observations WHERE conversation_id = ? ORDER BY seq`).all(conversationId) as Row[]).map(toObservation);
  }

  count(conversationId: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM memory_observations WHERE conversation_id = ?`).get(conversationId) as { n: number }).n;
  }
}

function toObservation(r: Row): Observation {
  return { id: r.id, conversationId: r.conversation_id, seq: r.seq, text: r.text, covered: r.covered, createdAt: r.created_at };
}
