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
  /** vec0 bakes the dimension into the table, so each one gets its own. */
  private readonly vecTable: string;

  constructor(
    private readonly db: Db,
    readonly dimension: number,
    private readonly now: () => number = Date.now,
    /**
     * Which embedder produced these vectors. Two providers' vectors are not
     * comparable, so recall is filtered to the active provider: adding an API
     * key later must not turn every existing vector into noise in the results.
     */
    private readonly provider: string = "unknown",
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
    // Older workspaces predate provenance; backfill the column in place.
    const columns = db
      .prepare(`PRAGMA table_info(memory_events)`)
      .all() as { name: string }[];
    if (!columns.some((c) => c.name === "provider")) {
      db.exec(`ALTER TABLE memory_events ADD COLUMN provider TEXT`);
    }
    this.vecTable = `memory_vec_${dimension}`;
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.vecTable} USING vec0(embedding float[${dimension}])`,
    );
  }

  add(userId: string, text: string, embedding: number[]): number {
    this.assertDimension(embedding);
    const ts = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO memory_events (user_id, text, created_at, provider)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, text, ts, this.provider);
    const id = Number(info.lastInsertRowid);
    // vec0 requires the rowid bound as a BigInt and the vector as a float blob.
    this.db
      .prepare(`INSERT INTO ${this.vecTable} (rowid, embedding) VALUES (?, ?)`)
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
        `SELECT rowid, distance FROM ${this.vecTable}
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(toBlob(embedding), k * 4) as { rowid: number; distance: number }[];

    const getEvent = this.db.prepare(`SELECT * FROM memory_events WHERE id = ?`);
    const hits: EpisodeHit[] = [];
    for (const c of candidates) {
      const row = getEvent.get(c.rowid) as (EventRow & { provider?: string }) | undefined;
      // Cross-provider vectors are not comparable, so they are not candidates.
      const sameProvider =
        row?.provider == null || row.provider === this.provider;
      if (row && row.user_id === userId && sameProvider) {
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
