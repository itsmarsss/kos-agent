import type { Db } from "../store/db.js";
import type { Project } from "./manifest.js";

/**
 * What the model is allowed to know about the tables it works on.
 *
 * It was not shown any of this. The prompt listed projects by slug and said
 * tables are namespaced to them, and left the model to guess column names.
 * On a real workspace that produced 77 failed sql calls, every one of them
 * `no such column` or `no such table`: created_at, ts, title, role, each a
 * reasonable guess at a table the model had never seen.
 *
 * So the schema goes in front of it. Physical names, because those are what
 * it has to type; column names, because names are what it was getting wrong;
 * no types, because the failures were never about types and the section
 * should stay small enough to sit in every prompt.
 */

export interface TableShape {
  /** The physical name, slug prefix included. */
  name: string;
  columns: string[];
}

export interface ProjectSchema {
  slug: string;
  tables: TableShape[];
  /** When the project was last worked on, which decides what the budget cuts. */
  lastTouchedAt: number;
}

/**
 * The tables belonging to one project, by its slug prefix.
 *
 * The migrator names every table `<slug>_<name>`, so the prefix is the
 * ownership rule rather than a heuristic. A workspace table that happens to
 * share a prefix with a slug would be listed too, which is the correct
 * reading: as far as the model is concerned it is that project's table.
 */
export function describeProject(
  db: Db,
  slug: string,
  lastTouchedAt = 0,
  /** Every project's slug, so a table under a longer sibling slug (pantry_2_items beside pantry) is not claimed. */
  siblings: string[] = [],
): ProjectSchema {
  const names = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE ? ESCAPE '\\'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         ORDER BY name`,
      )
      .all(`${slug.replace(/[%_]/g, "\\$&")}\\_%`) as { name: string }[]
  )
    .map((r) => r.name)
    .filter((name) => !siblings.some((other) => other !== slug && other.length > slug.length && (name === other || name.startsWith(`${other}_`))));

  const tables = names.map((name) => ({
    name,
    columns: (
      db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as {
        name: string;
      }[]
    ).map((c) => c.name),
  }));
  return { slug, tables, lastTouchedAt };
}

/** Everything the active projects own. */
export function describeActive(db: Db, projects: Project[]): ProjectSchema[] {
  const slugs = projects.map((p) => p.slug);
  return projects
    .filter((p) => p.status === "active")
    .map((p) => describeProject(db, p.slug, p.lastTouchedAt, slugs))
    .filter((s) => s.tables.length > 0);
}

/** Longest the section may be before it starts costing more than it saves. */
export const SCHEMA_BUDGET = 4000;

/**
 * The section itself.
 *
 * One line per table, projects in slug order. The order is fixed on purpose:
 * this sits in the cacheable prefix of every prompt, and a section that
 * reshuffled whenever a project was touched would miss the cache each time.
 * Only what gets cut follows recency: when the budget is short, the projects
 * worked on least recently go first, and whole projects go rather than a
 * table in half, because a partial table looks complete.
 */
export function renderSchemas(
  schemas: ProjectSchema[],
  budget = SCHEMA_BUDGET,
): string | undefined {
  if (schemas.length === 0) return undefined;
  const header = "## Tables (physical names; query these exactly)";
  const blocks = new Map(
    schemas.map((s) => [
      s.slug,
      s.tables.map((t) => `- ${t.name}: ${t.columns.join(", ")}`),
    ]),
  );
  const sizeOf = (slug: string): number =>
    blocks.get(slug)!.reduce((n, l) => n + l.length + 1, 0);

  const kept = new Set(schemas.map((s) => s.slug));
  let used = header.length + schemas.reduce((n, s) => n + sizeOf(s.slug), 0);
  for (const s of [...schemas].sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)) {
    if (used <= budget || kept.size === 1) break;
    kept.delete(s.slug);
    used -= sizeOf(s.slug);
  }

  const lines = [header];
  for (const s of [...schemas].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (kept.has(s.slug)) lines.push(...blocks.get(s.slug)!);
  }
  const dropped = schemas.length - kept.size;
  if (dropped > 0) {
    lines.push(
      `(${dropped} more project${dropped === 1 ? "" : "s"} not shown; ` +
        "run PRAGMA table_info(<table>) via sql to see one.)",
    );
  }
  return lines.join("\n");
}
