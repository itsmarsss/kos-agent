import * as sqliteVec from "sqlite-vec";

import type { Db } from "../store/db.js";

export interface Episode {
  id: number;
  userId: string;
  text: string;
  createdAt: number;
}

export interface EpisodeHit extends Episode {
  /** Vector distance to the query (smaller is closer). */
  distance: number;
}

interface EventRow {
  id: number;
  user_id: string;
  text: string;
  created_at: number;
}

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * Episodic memory: events stored with embeddings in sqlite-vec for semantic
 * recall. Event metadata lives in a normal table joined to the vec0 table by
 * rowid. This is the vector fallback tier, consulted after the structured store.
 */
export class EpisodicStore {
  constructor(
    private readonly db: Db,
    readonly dimension: number,
    private readonly now: () => number = Date.now,
  ) {
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${dimension}])`,
    );
  }

  add(userId: string, text: string, embedding: number[]): number {
    this.assertDimension(embedding);
    const ts = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO memory_events (user_id, text, created_at) VALUES (?, ?, ?)`,
      )
      .run(userId, text, ts);
    const id = Number(info.lastInsertRowid);
    // vec0 requires the rowid bound as a BigInt and the vector as a float blob.
    this.db
      .prepare(`INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(id), toBlob(embedding));
    return id;
  }

  /**
   * K nearest episodes for the query embedding, filtered to the user. The KNN
   * is global, so we over-fetch and then filter by user (fine for single-user;
   * a vec0 partition key is the multi-user upgrade).
   */
  search(userId: string, embedding: number[], k = 5): EpisodeHit[] {
    this.assertDimension(embedding);
    const candidates = this.db
      .prepare(
        `SELECT rowid, distance FROM memory_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(toBlob(embedding), k * 4) as { rowid: number; distance: number }[];

    const getEvent = this.db.prepare(`SELECT * FROM memory_events WHERE id = ?`);
    const hits: EpisodeHit[] = [];
    for (const c of candidates) {
      const row = getEvent.get(c.rowid) as EventRow | undefined;
      if (row && row.user_id === userId) {
        hits.push({
          id: row.id,
          userId: row.user_id,
          text: row.text,
          createdAt: row.created_at,
          distance: c.distance,
        });
        if (hits.length >= k) break;
      }
    }
    return hits;
  }

  private assertDimension(embedding: number[]): void {
    if (embedding.length !== this.dimension) {
      throw new Error(
        `embedding dimension ${embedding.length} != ${this.dimension}`,
      );
    }
  }
}
