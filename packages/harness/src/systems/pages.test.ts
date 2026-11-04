import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
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
    ws.db.exec("CREATE TABLE budget_tx (id INTEGER PRIMARY KEY, amount REAL); CREATE TABLE diary_entries (id INTEGER PRIMARY KEY, body TEXT);");
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
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", capabilities: { writes: [{ table: "diary_entries", columns: ["body"] }] } })).toThrow(/belongs to project "diary"/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", capabilities: { writes: [{ table: "tx", columns: ["amount"] }] } })).toThrow(/use "budget_tx"/);
    expect(() => pages.writeHtml("budget", { id: "x", title: "X", html: "<p>", headline: { label: "n", query: "DELETE FROM budget_tx" } })).toThrow(/read-only/);
    expect(() => pages.writeHtml("nope", { id: "x", title: "X", html: "<p>" })).toThrow(/unknown project/);
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
});
