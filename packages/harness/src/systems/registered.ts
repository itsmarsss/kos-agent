import type { Db } from "../store/db.js";
import { projectTable } from "./identifiers.js";

/**
 * The tables a project made: what its own migrations created, followed through
 * their renames, that still exist.
 *
 * A name is not a claim. Tables are named <slug>_<table>, so a project whose
 * slug happens to prefix one of KOS's own tables (permission_rules,
 * memory_claims, audit_log) would own it by name. Only the record of what a
 * project created says what is its own.
 */
export function registeredTables(db: Db, slug: string): Set<string> {
  const record = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  if (!record) return new Set();
  const rows = db
    .prepare(`SELECT spec_json FROM schema_migrations WHERE project_slug = ? AND op IN ('create_table', 'rename_table') ORDER BY version`)
    .all(slug) as { spec_json: string }[];
  const made = new Set<string>();
  for (const { spec_json } of rows) {
    const spec = JSON.parse(spec_json) as { op: string; table?: string; from?: string; to?: string };
    if (spec.op === "create_table" && spec.table) made.add(projectTable(slug, spec.table));
    if (spec.op === "rename_table" && spec.from && spec.to) {
      made.delete(projectTable(slug, spec.from));
      made.add(projectTable(slug, spec.to));
    }
  }
  const present = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name));
  return new Set([...made].filter((t) => present.has(t)));
}
