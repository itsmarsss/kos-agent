import type { Db } from "../store/db.js";

/**
 * Things memory wants the owner to look at.
 *
 * The dream job merges what is plainly the same and archives what is
 * plainly stale on its own. What is not plain, a contradiction too close
 * to call or a claim that would be promoted from a project to global,
 * is written here for the owner, with the claims it is about and a line
 * of reasoning, and waits.
 */

export type ReviewKind = "contradiction" | "promotion" | "other";

export interface ReviewItem {
  id: number;
  kind: ReviewKind;
  /** The claim keys it is about, scope-qualified: global/city, project:pantry/city. */
  keys: string[];
  note: string;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_review (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  keys TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);
`;

interface Row {
  id: number;
  kind: string;
  keys: string;
  note: string;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

function toItem(r: Row): ReviewItem {
  return { id: r.id, kind: r.kind as ReviewKind, keys: JSON.parse(r.keys) as string[], note: r.note, createdAt: r.created_at, resolvedAt: r.resolved_at, resolution: r.resolution };
}

export class ReviewQueue {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.db.exec(SCHEMA);
  }

  /** Add an item, unless the same kind about the same keys is already waiting. */
  add(kind: ReviewKind, keys: string[], note: string): ReviewItem {
    const sorted = [...new Set(keys)].sort();
    const open = this.pending().find((i) => i.kind === kind && JSON.stringify(i.keys) === JSON.stringify(sorted));
    if (open) return open;
    const info = this.db.prepare(`INSERT INTO memory_review (kind, keys, note, created_at) VALUES (?, ?, ?, ?)`)
      .run(kind, JSON.stringify(sorted), note.slice(0, 1000), this.now());
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): ReviewItem | undefined {
    const row = this.db.prepare(`SELECT * FROM memory_review WHERE id = ?`).get(id) as Row | undefined;
    return row ? toItem(row) : undefined;
  }

  pending(): ReviewItem[] {
    return (this.db.prepare(`SELECT * FROM memory_review WHERE resolved_at IS NULL ORDER BY id`).all() as Row[]).map(toItem);
  }

  recent(limit = 50): ReviewItem[] {
    return (this.db.prepare(`SELECT * FROM memory_review ORDER BY id DESC LIMIT ?`).all(limit) as Row[]).map(toItem);
  }

  resolve(id: number, resolution: string): ReviewItem | undefined {
    this.db.prepare(`UPDATE memory_review SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL`).run(this.now(), resolution.slice(0, 200), id);
    return this.get(id);
  }
}
