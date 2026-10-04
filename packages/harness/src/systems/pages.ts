import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  isValidPageSpec,
  validatePageSpec,
  type PageSpec,
} from "@kos/shared";

import type { Db } from "../store/db.js";
import type { Workspace } from "../store/workspace.js";
import type { ProjectManifest } from "./manifest.js";

/**
 * Agent-authored page specs: validated JSON stored under the project folder
 * and indexed in SQLite so the dashboard can list and render them.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface PageRecord {
  id: string;
  projectSlug: string;
  title: string;
  path: string;
  updatedAt: number;
}

/** The project a physical table belongs to: the longest slug that prefixes it. */
export function ownerOf(table: string, slugs: string[]): string | undefined {
  let best: string | undefined;
  for (const slug of slugs) {
    if ((table === slug || table.startsWith(`${slug}_`)) && (best === undefined || slug.length > best.length)) best = slug;
  }
  return best;
}

export class PageStore {
  constructor(
    private readonly db: Db,
    private readonly workspace: Workspace,
    private readonly manifest: ProjectManifest,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  private filePath(projectSlug: string, pageId: string): string {
    return join("projects", projectSlug, "pages", `${pageId}.json`);
  }

  list(projectSlug?: string): PageRecord[] {
    const rows = projectSlug
      ? (this.db
          .prepare(
            `SELECT id, project_slug, title, path, updated_at FROM pages
             WHERE project_slug = ? ORDER BY title`,
          )
          .all(projectSlug) as Array<{
          id: string;
          project_slug: string;
          title: string;
          path: string;
          updated_at: number;
        }>)
      : (this.db
          .prepare(
            `SELECT id, project_slug, title, path, updated_at FROM pages
             ORDER BY project_slug, title`,
          )
          .all() as Array<{
          id: string;
          project_slug: string;
          title: string;
          path: string;
          updated_at: number;
        }>);
    return rows.map((r) => ({
      id: r.id,
      projectSlug: r.project_slug,
      title: r.title,
      path: r.path,
      updatedAt: r.updated_at,
    }));
  }

  get(id: string): { record: PageRecord; spec: PageSpec } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_slug, title, path, updated_at FROM pages WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          project_slug: string;
          title: string;
          path: string;
          updated_at: number;
        }
      | undefined;
    if (!row) return undefined;
    const abs = this.workspace.resolve(row.path);
    if (!existsSync(abs)) return undefined;
    const spec = JSON.parse(readFileSync(abs, "utf8")) as PageSpec;
    return {
      record: {
        id: row.id,
        projectSlug: row.project_slug,
        title: row.title,
        path: row.path,
        updatedAt: row.updated_at,
      },
      spec,
    };
  }

  /**
   * A widget that writes has to name a table that exists.
   *
   * Tables are namespaced to the project slug on creation, so an agent that
   * writes the logical name gets a page that renders, passes validation, and
   * then fails on the first save with "no such table". The failure belongs at
   * write time, naming the physical table it should have used.
   */
  private assertMutationTablesExist(projectSlug: string, page: PageSpec): void {
    const exists = (table: string): boolean =>
      this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) !== undefined;

    page.widgets.forEach((widget, index) => {
      const target = (widget as { mutate?: { table?: unknown } }).mutate;
      const table = target?.table;
      if (typeof table !== "string" || table === "" || exists(table)) return;
      const namespaced = `${projectSlug}_${table}`;
      throw new Error(
        exists(namespaced)
          ? `widget[${index}]: mutation target table "${table}" does not exist. Tables are namespaced to the project, so use "${namespaced}".`
          : `widget[${index}]: mutation target table "${table}" does not exist. Create it with systems.migrate first.`,
      );
    });
  }

  /**
   * A page reads its own project's data, not another's.
   *
   * Tables are namespaced by slug, so a query naming another project's tables
   * says plainly that the page was filed in the wrong place. Left unchecked
   * the page renders correctly and the mistake shows up only as a stranger in
   * someone else's project on the Projects tab.
   */
  private assertQueriesStayInProject(projectSlug: string, page: PageSpec): void {
    const all = this.manifest.list().map((p) => p.slug);
    const others = all.filter((s) => s !== projectSlug);
    if (others.length === 0) return;

    page.widgets.forEach((widget, index) => {
      const query = (widget as { query?: unknown }).query;
      if (typeof query !== "string") return;
      for (const other of others) {
        // Word-boundary match on the namespace prefix: budget_tracker_expenses
        // belongs to budget_tracker, and nothing else looks like that.
        const re = new RegExp(`\\b${other}_[a-z0-9_]+`, "i");
        const hit = re.exec(query)?.[0];
        if (!hit) continue;
        // One slug can be a prefix of another: pantry and pantry_2. The
        // table belongs to the longest slug that prefixes it, which is how
        // a second instance of a blueprint keeps its own tables.
        const owner = ownerOf(hit, all);
        if (owner === projectSlug) continue;
        throw new Error(
          `widget[${index}]: query reads "${hit}", which belongs to project "${owner}", not "${projectSlug}". Write this page under "${owner}", or create the project it really belongs to.`,
        );
      }
    });
  }

  /**
   * Fill a stat's label from its title.
   *
   * Every other widget captions itself with `title`, so a stat is the one
   * place a separate `label` is required, and every model tested wrote
   * `title` and got rejected for it. The two say the same thing to a reader,
   * so the spec is completed rather than refused.
   */
  private static fillStatLabels(spec: unknown): unknown {
    if (typeof spec !== "object" || spec === null) return spec;
    const page = spec as { widgets?: unknown };
    if (!Array.isArray(page.widgets)) return spec;
    for (const widget of page.widgets) {
      if (typeof widget !== "object" || widget === null) continue;
      const w = widget as { type?: unknown; label?: unknown; title?: unknown };
      if (w.type !== "stat") continue;
      if (!w.label && typeof w.title === "string" && w.title !== "") {
        w.label = w.title;
      }
    }
    return spec;
  }

  /**
   * Validate and write a page spec. page id must match the spec id. Project
   * must already exist in the manifest.
   */
  write(projectSlug: string, spec: unknown): PageRecord {
    if (!this.manifest.get(projectSlug)) {
      throw new Error(`unknown project: ${projectSlug}`);
    }
    PageStore.fillStatLabels(spec);
    const errors = validatePageSpec(spec as PageSpec);
    if (errors.length > 0 || !isValidPageSpec(spec as PageSpec)) {
      throw new Error(`invalid page spec: ${errors.join("; ") || "failed validation"}`);
    }
    const page = spec as PageSpec;
    this.assertMutationTablesExist(projectSlug, page);
    this.assertQueriesStayInProject(projectSlug, page);
    const rel = this.filePath(projectSlug, page.id);
    const abs = this.workspace.resolve(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(page, null, 2));
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO pages (id, project_slug, title, path, updated_at)
         VALUES (@id, @projectSlug, @title, @path, @ts)
         ON CONFLICT(id) DO UPDATE SET
           project_slug = excluded.project_slug,
           title = excluded.title,
           path = excluded.path,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: page.id,
        projectSlug,
        title: page.title,
        path: rel,
        ts,
      });
    this.manifest.touchProject(projectSlug);
    return {
      id: page.id,
      projectSlug,
      title: page.title,
      path: rel,
      updatedAt: ts,
    };
  }

  remove(id: string): boolean {
    const got = this.get(id);
    if (!got) return false;
    const abs = this.workspace.resolve(got.record.path);
    if (existsSync(abs)) unlinkSync(abs);
    this.db.prepare(`DELETE FROM pages WHERE id = ?`).run(id);
    return true;
  }
}
