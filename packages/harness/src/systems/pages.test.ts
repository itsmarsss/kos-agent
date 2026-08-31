import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { PageStore } from "./pages.js";
import { runDisplayQuery } from "./display.js";

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
    expect(got?.spec.title).toBe("Overview");
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
    expect(pages.get("p")?.spec.widgets[0]).toMatchObject({
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
    expect(pages.get("q")?.spec.widgets[0]).toMatchObject({ label: "Real label" });
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
