import type { Db } from "../store/db.js";

/**
 * Things KOS thinks it could make reusable.
 *
 * The spec's self-improvement loop, and its one firm rule: the agent may
 * say "this looks reusable, want me to promote it?" but acts only on an
 * explicit yes. So a suggestion is a flag, not a change. KOS raises one from
 * a scheduled job that reads what it has built and done; the owner sees it in
 * the Inbox and either says go ahead, which opens a chat that carries it out
 * through the ordinary gates, or dismisses it.
 *
 * The shape mirrors the memory review queue, because the problem is the same:
 * something the agent noticed and cannot settle on its own.
 */

export type SuggestionKind = "skill" | "blueprint" | "other";

export interface Suggestion {
  id: number;
  kind: SuggestionKind;
  /** A short name for the thing, as it reads in a list. */
  title: string;
  /** What KOS saw, in a sentence or two: the evidence for the suggestion. */
  detail: string;
  /** The instruction KOS would carry out if the owner says yes. Absent means detail is it. */
  action: string | null;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS improvements (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  action TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);
`;

interface Row {
  id: number;
  kind: string;
  title: string;
  detail: string;
  action: string | null;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

function toSuggestion(r: Row): Suggestion {
  return {
    id: r.id,
    kind: r.kind as SuggestionKind,
    title: r.title,
    detail: r.detail,
    action: r.action,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
  };
}

const KINDS: SuggestionKind[] = ["skill", "blueprint", "other"];

export class SuggestionStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.db.exec(SCHEMA);
  }

  /** Raise a suggestion, unless the same kind with the same title is already open. */
  add(kind: SuggestionKind, title: string, detail: string, action?: string): Suggestion {
    const safeKind: SuggestionKind = KINDS.includes(kind) ? kind : "other";
    const name = title.trim().slice(0, 120);
    if (!name) throw new Error("a suggestion needs a title");
    const open = this.pending().find((s) => s.kind === safeKind && s.title.toLowerCase() === name.toLowerCase());
    if (open) return open;
    const info = this.db
      .prepare(`INSERT INTO improvements (kind, title, detail, action, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(safeKind, name, detail.slice(0, 2000), action?.trim().slice(0, 2000) || null, this.now());
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Suggestion | undefined {
    const row = this.db.prepare(`SELECT * FROM improvements WHERE id = ?`).get(id) as Row | undefined;
    return row ? toSuggestion(row) : undefined;
  }

  pending(): Suggestion[] {
    return (this.db.prepare(`SELECT * FROM improvements WHERE resolved_at IS NULL ORDER BY id`).all() as Row[]).map(toSuggestion);
  }

  recent(limit = 50): Suggestion[] {
    return (this.db.prepare(`SELECT * FROM improvements ORDER BY id DESC LIMIT ?`).all(limit) as Row[]).map(toSuggestion);
  }

  resolve(id: number, resolution: string): Suggestion | undefined {
    this.db
      .prepare(`UPDATE improvements SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL`)
      .run(this.now(), resolution.slice(0, 200), id);
    return this.get(id);
  }
}
