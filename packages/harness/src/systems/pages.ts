import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  isReadOnlyQuery,
  isValidPageSpec,
  sheetDataOf,
  sheetErrors,
  sheetTables,
  validateHtmlPage,
  validatePageSpec,
  withSheetData,
  type ArtifactEdit,
  type ArtifactKind,
  type HtmlPage,
  type PageSpec,
  type SheetBook,
} from "@kos/shared";

import type { Db } from "../store/db.js";
import type { Workspace } from "../store/workspace.js";
import { projectTable } from "./identifiers.js";
import type { ProjectManifest } from "./manifest.js";
import { withDocText } from "./artifactedit.js";
import { BridgeRefusal, tablesRead } from "./pagebridge.js";
import { registeredTables } from "./registered.js";

/**
 * Artifacts: what KOS writes for the owner to read and use, indexed in SQLite
 * so the dashboard can list and render them. An artifact is an HTML document
 * of one kind (page, doc, deck or sheet; artifacts.ts in @kos/shared), the
 * way a Claude artifact is (`writeHtml`), or, from before that, a JSON spec
 * over the widget library (`write`), which still renders as a page. It
 * belongs to a project, under the project's folder, or to no project, under
 * the workspace's `artifacts/`. Every write is kept as a version, so the
 * owner can go back to one, and so is every edit the owner makes in place.
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

/** The least time between two of the owner's saves to one artifact: an edit is a person typing, not a loop. */
export const EDIT_GAP_MS = 2000;

/**
 * An edit made on a version that is no longer the newest: KOS, or the owner
 * in another window, saved the artifact since. Taking it would silently
 * undo that save, so it is refused and the owner reloads.
 */
export class EditConflict extends Error {}

export type PageKind = "spec" | "html";

/**
 * Who an artifact belongs to: a project (its slug), a blob ({ blob: name }),
 * or the workspace (null). A blob owns what it makes as it owns its files,
 * in its own folder; like the workspace it has no tables, so its artifacts
 * reach none.
 */
export type PageOwner = string | null | { blob: string };

/** The owner's project, if it is one. */
const projectOf = (owner: PageOwner): string | null => (typeof owner === "string" ? owner : null);
/** The owner's blob, if it is one. */
const blobOf = (owner: PageOwner): string | null => (owner !== null && typeof owner === "object" ? owner.blob : null);
/** One owner as a word, to compare two. */
const ownerKey = (owner: PageOwner): string => (typeof owner === "string" ? `project:${owner}` : owner ? `blob:${owner.blob}` : "workspace");

export interface PageRecord {
  id: string;
  /** The project it belongs to; null for a blob's or a workspace artifact, which belong to none. */
  projectSlug: string | null;
  /** The blob it belongs to, when a blob made it; absent for a project's or the workspace's. */
  blob?: string;
  title: string;
  path: string;
  updatedAt: number;
  /** How it is stored: an HTML document, or an older widget spec. */
  kind: PageKind;
  /** What it is. A widget spec is a page. */
  artifactKind: ArtifactKind;
  description?: string;
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
  blob: string | null;
}

/** What an HTML page declares besides its markup, kept on its row. */
type HtmlMeta = Omit<HtmlPage, "id" | "title" | "html">;

/** The row's project_slug for a workspace artifact, which has no project. */
const WORKSPACE = "";

const metaOf = (r: Row): HtmlMeta => (r.kind === "html" && r.meta ? (JSON.parse(r.meta) as HtmlMeta) : {});

const recordOf = (r: Row): PageRecord => {
  const meta = metaOf(r);
  return {
    id: r.id,
    projectSlug: r.project_slug === WORKSPACE ? null : r.project_slug,
    ...(r.blob ? { blob: r.blob } : {}),
    title: r.title,
    path: r.path,
    updatedAt: r.updated_at,
    kind: r.kind === "html" ? "html" : "spec",
    artifactKind: meta.kind ?? "page",
    ...(meta.description ? { description: meta.description } : {}),
  };
};

/** Who a row belongs to. */
const ownerOfRow = (r: Row): PageOwner => (r.blob ? { blob: r.blob } : r.project_slug === WORKSPACE ? null : r.project_slug);

/** Who a record belongs to. */
export const ownerOfRecord = (r: PageRecord): PageOwner => (r.blob ? { blob: r.blob } : r.projectSlug);

/** Where an artifact's file lives: its project's pages folder, its blob's artifacts folder beside its files, or the workspace's. */
const folderOf = (owner: PageOwner): string => {
  const project = projectOf(owner);
  const blob = blobOf(owner);
  return project ? join("projects", project, "pages") : blob ? join("blobs", blob, "artifacts") : "artifacts";
};

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
  /** When each artifact last took one of the owner's edits. */
  private readonly lastEdit = new Map<string, number>();

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
    // The blob that owns it, added once blobs could own artifacts: every older row keeps its project or the workspace.
    if (!cols.has("blob")) this.db.exec(`ALTER TABLE pages ADD COLUMN blob TEXT`);
  }

  private row(id: string): Row | undefined {
    return this.db.prepare(`SELECT id, project_slug, title, path, updated_at, kind, meta, blob FROM pages WHERE id = ?`).get(id) as Row | undefined;
  }

  /** Every artifact, or one owner's: a project's, a blob's ({ blob }), or the workspace's own (null). */
  list(owner?: PageOwner): PageRecord[] {
    const cols = `id, project_slug, title, path, updated_at, kind, meta, blob`;
    const blob = owner === undefined ? undefined : blobOf(owner);
    const rows = (
      owner === undefined
        ? this.db.prepare(`SELECT ${cols} FROM pages ORDER BY project_slug, title`).all()
        : blob
          ? this.db.prepare(`SELECT ${cols} FROM pages WHERE blob = ? ORDER BY title`).all(blob)
          : this.db.prepare(`SELECT ${cols} FROM pages WHERE project_slug = ? AND blob IS NULL ORDER BY title`).all(projectOf(owner) ?? WORKSPACE)
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
      return { record, kind: "html", page: { id: row.id, title: row.title, html: readFileSync(abs, "utf8"), ...metaOf(row) } };
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
   * Validate and write an HTML artifact. What it may reach is checked here as
   * well as on every call: a table it says it writes, its headline reads, or
   * its sheet shows live, must be one its project made (registered.ts), so
   * the mistake is named now rather than on the owner's first save. A
   * workspace artifact (no project) has no tables or files to reach.
   */
  writeHtml(owner: PageOwner, input: unknown): PageRecord {
    const projectSlug = projectOf(owner);
    const blob = blobOf(owner);
    if (projectSlug !== null && !this.manifest.get(projectSlug)) {
      throw new Error(`unknown project: ${projectSlug}`);
    }
    if (blob !== null && !/^[a-z0-9][a-z0-9-]*$/.test(blob)) throw new Error(`not a blob's name: ${blob}`);
    const errors = validateHtmlPage(input);
    if (errors.length > 0) throw new Error(`invalid artifact: ${errors.join("; ")}`);
    const page = input as HtmlPage;
    if (projectSlug === null) {
      const reaches = [page.capabilities?.writes?.length ? "capabilities.writes" : "", page.capabilities?.files ? "capabilities.files" : "", page.headline ? "a headline" : ""].filter(Boolean);
      const whose = blob ? `a blob's artifact (${blob}'s)` : "a workspace artifact";
      if (reaches.length) throw new Error(`${whose} belongs to no project, so it has no tables or files; drop ${reaches.join(", ")}, or write it under the project whose data it shows`);
    }
    const tables = projectSlug === null ? new Set<string>() : registeredTables(this.db, projectSlug);
    const holder = projectSlug ?? (blob ? `the blob ${blob}` : "the workspace");
    for (const [i, target] of (page.capabilities?.writes ?? []).entries()) {
      if (tables.has(target.table)) continue;
      const namespaced = projectTable(projectSlug ?? "", target.table);
      const hint = tables.has(namespaced) ? `use "${namespaced}"` : "create it with systems.migrate first";
      throw new Error(`capabilities.writes[${i}]: "${target.table}" is not a table of project "${holder}"; ${hint}`);
    }
    if (page.kind === "sheet") {
      const book = JSON.parse(sheetDataOf(page.html) ?? "{}") as SheetBook;
      for (const table of sheetTables(book)) {
        if (!tables.has(table)) throw new Error(`the sheet reads "${table}", which is not a table of ${projectSlug ? `project "${projectSlug}"` : "this artifact: a workspace artifact has none"}`);
      }
    }
    if (page.headline) {
      if (!isReadOnlyQuery(page.headline.query)) throw new Error("headline.query must be a single read-only SELECT");
      try {
        for (const table of tablesRead(this.db, page.headline.query, [])) {
          if (!tables.has(table)) throw new BridgeRefusal(`it reads "${table}", which is not a table of project "${holder}"`);
        }
      } catch (err) {
        throw new Error(`headline.query: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const { id: _id, title: _title, html: _html, ...declared } = page;
    const meta: HtmlMeta = Object.fromEntries(Object.entries(declared).filter(([, v]) => v !== undefined && v !== "")) as HtmlMeta;
    return this.save(owner, page.id, page.title, "html", repairClosingTags(page.html), meta);
  }

  /**
   * The owner's edit, made in place in a doc or a sheet, kept as the
   * artifact's next version. Only the kind's own region changes (a doc's
   * article, a sheet's data), and the result goes through every check a
   * write does, so an edit can reach nothing a write could not.
   *
   * `base` is the version the edit was made on (its record's updatedAt): an
   * edit on an older one is an EditConflict. An edit that changes nothing is
   * refused, and an artifact takes one edit every EDIT_GAP_MS, so a page that
   * calls kos.save in a loop cannot fill its history.
   */
  applyEdit(id: string, edit: ArtifactEdit, base: unknown): PageRecord {
    const got = this.get(id);
    if (!got || got.kind !== "html") throw new Error(`artifact not found: ${id}`);
    if (typeof base !== "number") throw new Error("an edit says which version it was made on");
    if (base !== got.record.updatedAt) {
      throw new EditConflict("This artifact changed after it was opened: KOS or another window saved a newer version. Reload it to see that one, then make the edit again.");
    }
    const page = got.page;
    let html: string;
    if ("doc" in edit && page.kind === "doc" && typeof edit.doc === "string") {
      html = withDocText(page.html, edit.doc);
    } else if ("sheet" in edit && page.kind === "sheet") {
      const errors = sheetErrors(edit.sheet);
      if (errors.length) throw new Error(`the sheet cannot be saved: ${errors.join("; ")}`);
      const before = JSON.parse(sheetDataOf(page.html) ?? "{}") as SheetBook;
      // The owner edits the data, not where it comes from: a tab's live source stays as written.
      if (JSON.stringify(sheetTables(before)) !== JSON.stringify(sheetTables(edit.sheet))) throw new Error("an edit cannot change which tables the sheet reads");
      html = withSheetData(page.html, edit.sheet);
    } else {
      throw new Error(page.kind === "doc" || page.kind === "sheet" ? "that edit does not fit this artifact" : "only a doc or a sheet is edited in place");
    }
    if (html === page.html) throw new Error("nothing changed: the edit leaves the artifact as it is");
    const now = this.now();
    const last = this.lastEdit.get(id);
    if (last !== undefined && now - last < EDIT_GAP_MS) throw new Error("saved a moment ago; wait a second and save again");
    const record = this.writeHtml(ownerOfRecord(got.record), { ...page, html });
    this.lastEdit.set(id, now);
    return record;
  }

  /** Write a page's file and row, and keep the write as a version. */
  private save(owner: PageOwner, id: string, title: string, kind: PageKind, body: string, meta: HtmlMeta | null): PageRecord {
    const projectSlug = projectOf(owner);
    const blob = blobOf(owner);
    const previous = this.row(id);
    const rel = join(folderOf(owner), `${id}.${kind === "html" ? "html" : "json"}`);
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
        `INSERT INTO pages (id, project_slug, title, path, updated_at, kind, meta, blob)
         VALUES (@id, @projectSlug, @title, @path, @ts, @kind, @meta, @blob)
         ON CONFLICT(id) DO UPDATE SET
           project_slug = excluded.project_slug,
           blob = excluded.blob,
           title = excluded.title,
           path = excluded.path,
           updated_at = excluded.updated_at,
           kind = excluded.kind,
           meta = excluded.meta`,
      )
      .run({ id, projectSlug: projectSlug ?? WORKSPACE, title, path: rel, ts, kind, meta: metaText, blob });
    // An artifact moved between owners takes its history and captures with it.
    const was = previous ? ownerOfRow(previous) : undefined;
    if (was !== undefined && ownerKey(was) !== ownerKey(owner)) {
      for (const sub of [".history", ".captures"]) {
        const from = this.workspace.resolve(join(folderOf(was), sub, id));
        const to = this.workspace.resolve(join(folderOf(owner), sub, id));
        if (!existsSync(from)) continue;
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
      }
    }
    this.keepVersion(owner, id, { at: ts, title, kind, body, meta });
    if (projectSlug) this.manifest.touchProject(projectSlug);
    return recordOf({ id, project_slug: projectSlug ?? WORKSPACE, title, path: rel, updated_at: ts, kind, meta: metaText, blob });
  }

  /** Where artifacts.check keeps an artifact's renders, which the gallery shows as its thumbnail. */
  capturesDir(id: string): string {
    const row = this.row(id);
    return this.workspace.resolve(join(folderOf(row ? ownerOfRow(row) : null), ".captures", id));
  }

  private historyDir(owner: PageOwner, id: string): string {
    return this.workspace.resolve(join(folderOf(owner), ".history", id));
  }

  private keepVersion(owner: PageOwner, id: string, snapshot: { at: number; title: string; kind: PageKind; body: string; meta: HtmlMeta | null }): void {
    const dir = this.historyDir(owner, id);
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
    const dir = this.historyDir(ownerOfRow(row), id);
    return this.versionNumbers(dir).map((version) => {
      const v = JSON.parse(readFileSync(join(dir, `${version}.json`), "utf8")) as { at: number; title: string; kind: PageKind };
      return { version, at: v.at, title: v.title, kind: v.kind };
    });
  }

  /** An HTML artifact as it was at a version, to look at: nothing is written. */
  version(id: string, version: number): HtmlPage | undefined {
    const row = this.row(id);
    if (!row || !Number.isInteger(version)) return undefined;
    const file = join(this.historyDir(ownerOfRow(row), id), `${version}.json`);
    if (!existsSync(file)) return undefined;
    const v = JSON.parse(readFileSync(file, "utf8")) as { title: string; kind: PageKind; body: string; meta: HtmlMeta | null };
    return v.kind === "html" ? { id, title: v.title, html: v.body, ...(v.meta ?? {}) } : undefined;
  }

  /**
   * Put a page back as it was at a version. It goes through the same checks as
   * any write, against the tables as they are now, and is itself kept as a
   * version, so a rollback can be undone. The owner's restore names the
   * version it was made on (`base`), as an edit does: one made on an older
   * version is an EditConflict rather than a silent overwrite.
   */
  rollback(id: string, version: number, base?: unknown): PageRecord {
    const row = this.row(id);
    if (!row) throw new Error(`page not found: ${id}`);
    if (base !== undefined && base !== row.updated_at) {
      throw new EditConflict("This artifact changed after it was opened: KOS or another window saved a newer version. Reload it, then restore again.");
    }
    const owner = ownerOfRow(row);
    const projectSlug = projectOf(owner);
    const file = join(this.historyDir(owner, id), `${version}.json`);
    if (!Number.isInteger(version) || !existsSync(file)) throw new Error(`page ${id} has no version ${version}`);
    const v = JSON.parse(readFileSync(file, "utf8")) as { title: string; kind: PageKind; body: string; meta: HtmlMeta | null };
    if (v.kind === "html") return this.writeHtml(owner, { id, title: v.title, html: v.body, ...(v.meta ?? {}) });
    if (projectSlug === null) throw new Error(`page ${id} version ${version} is a widget spec, which needs a project`);
    return this.write(projectSlug, JSON.parse(v.body));
  }

  remove(id: string): boolean {
    const got = this.get(id);
    if (!got) return false;
    const abs = this.workspace.resolve(got.record.path);
    if (existsSync(abs)) unlinkSync(abs);
    rmSync(this.historyDir(ownerOfRecord(got.record), id), { recursive: true, force: true });
    rmSync(this.capturesDir(id), { recursive: true, force: true });
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
