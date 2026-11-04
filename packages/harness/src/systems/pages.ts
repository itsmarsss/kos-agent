import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  isReadOnlyQuery,
  isValidPageSpec,
  validateHtmlPage,
  validatePageSpec,
  type HtmlPage,
  type PageSpec,
} from "@kos/shared";

import type { Db } from "../store/db.js";
import type { Workspace } from "../store/workspace.js";
import type { ProjectManifest } from "./manifest.js";

/**
 * Agent-authored pages, stored under the project folder and indexed in SQLite
 * so the dashboard can list and render them. A page is an HTML document the
 * agent writes, the way a Claude artifact is (`writeHtml`), or, from before
 * that, a JSON spec over the widget library (`write`), which still renders.
 * Every write is kept as a version, so the owner can go back to one.
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

/** How many versions of one page are kept; older ones go. */
const VERSIONS_KEPT = 30;

export type PageKind = "spec" | "html";

export interface PageRecord {
  id: string;
  projectSlug: string;
  title: string;
  path: string;
  updatedAt: number;
  kind: PageKind;
}

/** A page as stored: a spec for the widget library, or an HTML page. */
export type LoadedPage = { record: PageRecord; kind: "spec"; spec: PageSpec } | { record: PageRecord; kind: "html"; page: HtmlPage };

/** One kept write of a page, newest last. */
export interface PageVersion {
  version: number;
  at: number;
  title: string;
  kind: PageKind;
}

interface Row {
  id: string;
  project_slug: string;
  title: string;
  path: string;
  updated_at: number;
  kind: string | null;
  meta: string | null;
}

/** What an HTML page declares besides its markup, kept on its row. */
type HtmlMeta = Omit<HtmlPage, "id" | "title" | "html">;

const recordOf = (r: Row): PageRecord => ({
  id: r.id,
  projectSlug: r.project_slug,
  title: r.title,
  path: r.path,
  updatedAt: r.updated_at,
  kind: r.kind === "html" ? "html" : "spec",
});

/**
 * Models write `<\/script>` because that is how a closing tag is escaped inside
 * a JavaScript string; in HTML it closes nothing and the page silently does
 * nothing. It has no meaning in HTML, so it is repaired on the way in.
 */
const repairClosingTags = (html: string): string => html.replace(/<\\\//g, "</");

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
    // An HTML page's kind and declarations, added to a table that predates them.
    const cols = new Set((this.db.prepare(`PRAGMA table_info(pages)`).all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("kind")) this.db.exec(`ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'spec'`);
    if (!cols.has("meta")) this.db.exec(`ALTER TABLE pages ADD COLUMN meta TEXT`);
  }

  private row(id: string): Row | undefined {
    return this.db.prepare(`SELECT id, project_slug, title, path, updated_at, kind, meta FROM pages WHERE id = ?`).get(id) as Row | undefined;
  }

  private filePath(projectSlug: string, pageId: string): string {
    return join("projects", projectSlug, "pages", `${pageId}.json`);
  }

  list(projectSlug?: string): PageRecord[] {
    const cols = `id, project_slug, title, path, updated_at, kind, meta`;
    const rows = (
      projectSlug
        ? this.db.prepare(`SELECT ${cols} FROM pages WHERE project_slug = ? ORDER BY title`).all(projectSlug)
        : this.db.prepare(`SELECT ${cols} FROM pages ORDER BY project_slug, title`).all()
    ) as Row[];
    return rows.map(recordOf);
  }

  get(id: string): LoadedPage | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    const abs = this.workspace.resolve(row.path);
    if (!existsSync(abs)) return undefined;
    const record = recordOf(row);
    if (record.kind === "html") {
      const meta = (row.meta ? JSON.parse(row.meta) : {}) as HtmlMeta;
      return { record, kind: "html", page: { id: row.id, title: row.title, html: readFileSync(abs, "utf8"), ...meta } };
    }
    return { record, kind: "spec", spec: JSON.parse(readFileSync(abs, "utf8")) as PageSpec };
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
    return this.save(projectSlug, page.id, page.title, "spec", JSON.stringify(page, null, 2), null);
  }

  /**
   * Validate and write an HTML page. What it may reach is checked here as well
   * as on every call: a table it says it writes must exist and be its own
   * project's, so the mistake is named now rather than on the owner's first save.
   */
  writeHtml(projectSlug: string, input: unknown): PageRecord {
    if (!this.manifest.get(projectSlug)) {
      throw new Error(`unknown project: ${projectSlug}`);
    }
    const errors = validateHtmlPage(input);
    if (errors.length > 0) throw new Error(`invalid page: ${errors.join("; ")}`);
    const page = input as HtmlPage;
    const slugs = this.manifest.list().map((p) => p.slug);
    for (const [i, target] of (page.capabilities?.writes ?? []).entries()) {
      const exists = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(target.table) !== undefined;
      if (!exists) {
        const namespaced = `${projectSlug}_${target.table}`;
        const hint = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(namespaced) ? `use "${namespaced}"` : "create it with systems.migrate first";
        throw new Error(`capabilities.writes[${i}]: table "${target.table}" does not exist; ${hint}`);
      }
      const owner = ownerOf(target.table, slugs);
      if (owner !== projectSlug) {
        throw new Error(`capabilities.writes[${i}]: table "${target.table}" belongs to ${owner ? `project "${owner}"` : "no project"}, not "${projectSlug}"`);
      }
    }
    if (page.headline && !isReadOnlyQuery(page.headline.query)) {
      throw new Error("headline.query must be a single read-only SELECT");
    }
    const meta: HtmlMeta = {
      ...(page.capabilities ? { capabilities: page.capabilities } : {}),
      ...(page.libraries ? { libraries: page.libraries } : {}),
      ...(page.headline ? { headline: page.headline } : {}),
    };
    return this.save(projectSlug, page.id, page.title, "html", repairClosingTags(page.html), meta);
  }

  /** Write a page's file and row, and keep the write as a version. */
  private save(projectSlug: string, id: string, title: string, kind: PageKind, body: string, meta: HtmlMeta | null): PageRecord {
    const previous = this.row(id);
    const rel = join("projects", projectSlug, "pages", `${id}.${kind === "html" ? "html" : "json"}`);
    const abs = this.workspace.resolve(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    // A page that changed kind leaves its old file behind otherwise.
    if (previous && previous.path !== rel) {
      const old = this.workspace.resolve(previous.path);
      if (existsSync(old)) unlinkSync(old);
    }
    const ts = this.now();
    const metaText = meta ? JSON.stringify(meta) : null;
    this.db
      .prepare(
        `INSERT INTO pages (id, project_slug, title, path, updated_at, kind, meta)
         VALUES (@id, @projectSlug, @title, @path, @ts, @kind, @meta)
         ON CONFLICT(id) DO UPDATE SET
           project_slug = excluded.project_slug,
           title = excluded.title,
           path = excluded.path,
           updated_at = excluded.updated_at,
           kind = excluded.kind,
           meta = excluded.meta`,
      )
      .run({ id, projectSlug, title, path: rel, ts, kind, meta: metaText });
    this.keepVersion(projectSlug, id, { at: ts, title, kind, body, meta });
    this.manifest.touchProject(projectSlug);
    return { id, projectSlug, title, path: rel, updatedAt: ts, kind };
  }

  private historyDir(projectSlug: string, id: string): string {
    return this.workspace.resolve(join("projects", projectSlug, "pages", ".history", id));
  }

  private keepVersion(projectSlug: string, id: string, snapshot: { at: number; title: string; kind: PageKind; body: string; meta: HtmlMeta | null }): void {
    const dir = this.historyDir(projectSlug, id);
    mkdirSync(dir, { recursive: true });
    const numbers = this.versionNumbers(dir);
    const next = (numbers.at(-1) ?? 0) + 1;
    writeFileSync(join(dir, `${next}.json`), JSON.stringify(snapshot));
    for (const old of numbers.slice(0, Math.max(0, numbers.length + 1 - VERSIONS_KEPT))) unlinkSync(join(dir, `${old}.json`));
  }

  private versionNumbers(dir: string): number[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** Every kept write of a page, oldest first; the last is what shows now. */
  history(id: string): PageVersion[] {
    const row = this.row(id);
    if (!row) return [];
    const dir = this.historyDir(row.project_slug, id);
    return this.versionNumbers(dir).map((version) => {
      const v = JSON.parse(readFileSync(join(dir, `${version}.json`), "utf8")) as { at: number; title: string; kind: PageKind };
      return { version, at: v.at, title: v.title, kind: v.kind };
    });
  }

  /**
   * Put a page back as it was at a version. It goes through the same checks as
   * any write, against the tables as they are now, and is itself kept as a
   * version, so a rollback can be undone.
   */
  rollback(id: string, version: number): PageRecord {
    const row = this.row(id);
    if (!row) throw new Error(`page not found: ${id}`);
    const file = join(this.historyDir(row.project_slug, id), `${version}.json`);
    if (!Number.isInteger(version) || !existsSync(file)) throw new Error(`page ${id} has no version ${version}`);
    const v = JSON.parse(readFileSync(file, "utf8")) as { title: string; kind: PageKind; body: string; meta: HtmlMeta | null };
    if (v.kind === "html") return this.writeHtml(row.project_slug, { id, title: v.title, html: v.body, ...(v.meta ?? {}) });
    return this.write(row.project_slug, JSON.parse(v.body));
  }

  remove(id: string): boolean {
    const got = this.get(id);
    if (!got) return false;
    const abs = this.workspace.resolve(got.record.path);
    if (existsSync(abs)) unlinkSync(abs);
    rmSync(this.historyDir(got.record.projectSlug, id), { recursive: true, force: true });
    this.db.prepare(`DELETE FROM pages WHERE id = ?`).run(id);
    return true;
  }

  /**
   * Delete every page a project owns, records and files, and remove the
   * `projects/<slug>` folder so nothing is left on disk to re-discover.
   * Returns the number of page records removed.
   */
  removeProject(projectSlug: string): number {
    const info = this.db
      .prepare(`DELETE FROM pages WHERE project_slug = ?`)
      .run(projectSlug);
    const abs = this.workspace.resolve(join("projects", projectSlug));
    rmSync(abs, { recursive: true, force: true });
    return info.changes;
  }
}
