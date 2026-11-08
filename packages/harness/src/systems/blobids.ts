import { randomUUID } from "node:crypto";

import type { Db } from "../store/db.js";

/**
 * Which blob is which, apart from its name. A blob's name is its folder and
 * its thread, and a removed blob's name can be given to a new one; what the
 * old one made must not pass to the new one with it. So each blob, when it
 * is made, gets an id of its own, kept here and on whatever it owns (its
 * artifacts' rows). A removed blob's id is retired, never handed out again:
 * a blob made later under the same name is a new owner with a new id.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blob_ids (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  made_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS blob_ids_live ON blob_ids(name) WHERE removed_at IS NULL;
`;

export class BlobIds {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  /** The id of the blob now living under this name, if one has been given. */
  live(name: string): string | undefined {
    return (this.db.prepare(`SELECT id FROM blob_ids WHERE name = ? AND removed_at IS NULL`).get(name) as { id: string } | undefined)?.id;
  }

  /** The living blob's id, given now if it has none yet (one made before ids, or by hand). */
  ensure(name: string): string {
    const had = this.live(name);
    if (had) return had;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO blob_ids (id, name, made_at) VALUES (?, ?, ?)`).run(id, name, this.now());
    return id;
  }

  /** The blob under this name is gone: its id is retired, and the name is free for a new one. */
  retire(name: string): void {
    this.db.prepare(`UPDATE blob_ids SET removed_at = ? WHERE name = ? AND removed_at IS NULL`).run(this.now(), name);
  }

  /** An id that was never a living blob's: for work left by a blob removed before ids were kept. */
  retired(name: string): string {
    const id = randomUUID();
    const at = this.now();
    this.db.prepare(`INSERT INTO blob_ids (id, name, made_at, removed_at) VALUES (?, ?, ?, ?)`).run(id, name, at, at);
    return id;
  }

  /** Whether this id's blob has been removed. An unknown id counts as removed: nobody living holds it. */
  removed(id: string): boolean {
    const row = this.db.prepare(`SELECT removed_at FROM blob_ids WHERE id = ?`).get(id) as { removed_at: number | null } | undefined;
    return !row || row.removed_at !== null;
  }
}
