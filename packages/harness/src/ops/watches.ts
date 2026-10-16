import type { Db } from "../store/db.js";

/**
 * Pages watched for change.
 *
 * A watcher is a page read on a schedule and compared with what it said
 * last time. The page itself is the agent's to open; this keeps what was
 * read, under a name, and says whether it moved and how. Kept as text
 * rather than a hash so the difference can be said, not just announced.
 */

export interface WatchLook {
  key: string;
  url: string;
  /** Nothing to compare with yet: this is the first reading. */
  first: boolean;
  changed: boolean;
  /** When the page was last seen different from the time before, or first read. */
  changedAt: number;
  seenAt: number;
  /** The lines that went and came, when it changed. */
  diff?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS page_watches (
  key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);
`;

/** The page as lines worth comparing: trimmed, single-spaced, no blanks. */
export function normalizeText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * What went and what came, as lines. A set difference rather than an
 * alignment: a watched page is read for news, and "these lines are new"
 * is the news; where exactly they moved to is not.
 */
export function lineDiff(before: string, after: string, cap = 30): string {
  const was = normalizeText(before);
  const now = normalizeText(after);
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  const removed = was.filter((l) => !nowSet.has(l));
  const added = now.filter((l) => !wasSet.has(l));
  const show = (sign: string, lines: string[]): string[] => [
    ...lines.slice(0, cap).map((l) => `${sign} ${l.length > 200 ? `${l.slice(0, 200)}…` : l}`),
    ...(lines.length > cap ? [`${sign} (${lines.length - cap} more)`] : []),
  ];
  return [...show("-", removed), ...show("+", added)].join("\n");
}

export class PageWatchStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  /** A fresh reading of a page, against the last one under the same key. */
  look(key: string, url: string, text: string): WatchLook {
    const at = this.now();
    const row = this.db.prepare(`SELECT url, text, seen_at, changed_at FROM page_watches WHERE key = ?`).get(key) as
      | { url: string; text: string; seen_at: number; changed_at: number }
      | undefined;
    if (!row) {
      this.db.prepare(`INSERT INTO page_watches (key, url, text, seen_at, changed_at) VALUES (?, ?, ?, ?, ?)`).run(key, url, text, at, at);
      return { key, url, first: true, changed: false, changedAt: at, seenAt: at };
    }
    const changed = normalizeText(row.text).join("\n") !== normalizeText(text).join("\n");
    const changedAt = changed ? at : row.changed_at;
    this.db.prepare(`UPDATE page_watches SET url = ?, text = ?, seen_at = ?, changed_at = ? WHERE key = ?`).run(url, text, at, changedAt, key);
    return { key, url, first: false, changed, changedAt, seenAt: at, ...(changed ? { diff: lineDiff(row.text, text) } : {}) };
  }

  list(): { key: string; url: string; seenAt: number; changedAt: number }[] {
    const rows = this.db.prepare(`SELECT key, url, seen_at, changed_at FROM page_watches ORDER BY key`).all() as { key: string; url: string; seen_at: number; changed_at: number }[];
    return rows.map((r) => ({ key: r.key, url: r.url, seenAt: r.seen_at, changedAt: r.changed_at }));
  }

  forget(key: string): boolean {
    return this.db.prepare(`DELETE FROM page_watches WHERE key = ?`).run(key).changes > 0;
  }
}
