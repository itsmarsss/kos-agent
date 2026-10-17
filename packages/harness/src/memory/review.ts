import type { Db } from "../store/db.js";

/**
 * Things memory wants the owner to look at.
 *
 * The dream job merges what is plainly the same and archives what is
 * plainly stale on its own. What is not plain, a contradiction too close
 * to call or a claim that would be promoted from a project to global,
 * is written here with the claims it is about, a line of reasoning, what
 * the job would do about it and how sure it is. Sure enough, and the job
 * does that itself and the item is settled as it was made; otherwise it
 * waits for the owner, with the lean in front of them.
 */

export type ReviewKind = "contradiction" | "promotion" | "other";

export interface ReviewItem {
  id: number;
  kind: ReviewKind;
  /** The claim keys it is about, scope-qualified: global/city, project:pantry/city. */
  keys: string[];
  note: string;
  /** What KOS would do: "keep global/city", "both", "promote" or "dismiss". Null on an item from before it said. */
  lean: string | null;
  /** How sure it was of that, 0 to 1. */
  sure: number | null;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

/** What the job thinks, handed in with the question. */
export interface ReviewLean {
  lean: string;
  sure: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_review (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  keys TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT,
  lean TEXT,
  sure REAL
);
`;

interface Row {
  id: number;
  kind: string;
  keys: string;
  note: string;
  lean: string | null;
  sure: number | null;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

function toItem(r: Row): ReviewItem {
  return {
    id: r.id,
    kind: r.kind as ReviewKind,
    keys: JSON.parse(r.keys) as string[],
    note: r.note,
    lean: r.lean,
    sure: r.sure,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
  };
}

export class ReviewQueue {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.db.exec(SCHEMA);
    // A table from before the job said what it leaned to gains the columns;
    // its items read as having said nothing.
    const columns = new Set((this.db.prepare(`PRAGMA table_info(memory_review)`).all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("lean")) {
      this.db.exec(`ALTER TABLE memory_review ADD COLUMN lean TEXT; ALTER TABLE memory_review ADD COLUMN sure REAL;`);
    }
  }

  /**
   * Add an item, unless the same kind about the same keys is already waiting:
   * then that one carries the newer note and lean, since the job looked
   * again with fresher eyes, and is returned.
   */
  add(kind: ReviewKind, keys: string[], note: string, view?: ReviewLean): ReviewItem {
    const sorted = [...new Set(keys)].sort();
    const open = this.pending().find((i) => i.kind === kind && JSON.stringify(i.keys) === JSON.stringify(sorted));
    const lean = view?.lean.slice(0, 200) ?? null;
    const sure = view ? Math.min(1, Math.max(0, view.sure)) : null;
    if (open) {
      this.db.prepare(`UPDATE memory_review SET note = ?, lean = ?, sure = ? WHERE id = ?`).run(note.slice(0, 1000), lean, sure, open.id);
      return this.get(open.id)!;
    }
    const info = this.db.prepare(`INSERT INTO memory_review (kind, keys, note, lean, sure, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(kind, JSON.stringify(sorted), note.slice(0, 1000), lean, sure, this.now());
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
