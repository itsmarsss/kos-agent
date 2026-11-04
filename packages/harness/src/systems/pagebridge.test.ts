import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HtmlPage } from "@kos/shared";

import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { BridgeRefusal, pageFile, pageQuery, pageWrite, tablesRead, type BridgePage } from "./pagebridge.js";

/**
 * What an HTML page reaches through window.kos, which is everything it can
 * reach: its own project's tables, read-only and bounded; the tables it
 * declared, written through the guarded path; and its own project's files.
 */
describe("the page bridge", () => {
  let root: string;
  let ws: Workspace;
  let slugs: string[];

  const bridge = (page: Partial<HtmlPage> = {}): BridgePage => ({
    page: { id: "p", title: "P", html: "<p>x</p>", ...page },
    projectSlug: "budget",
    slugs,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-bridge-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    manifest.createProject({ name: "Budget", type: "tracker" });
    manifest.createProject({ name: "Diary", type: "notes" });
    slugs = manifest.list().map((p) => p.slug);
    ws.db.exec(`
      CREATE TABLE budget_tx (id INTEGER PRIMARY KEY, amount REAL, note TEXT, secret TEXT);
      CREATE TABLE diary_entries (id INTEGER PRIMARY KEY, body TEXT);
      CREATE VIEW budget_peek AS SELECT body FROM diary_entries;
      INSERT INTO budget_tx (amount, note) VALUES (12.5, 'coffee'), (40, 'books'), (7, 'bus');
      INSERT INTO diary_entries (body) VALUES ('private');
    `);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the page's own tables, with parameters", () => {
    const res = pageQuery(ws.reader, bridge(), "SELECT note FROM budget_tx WHERE amount > ? ORDER BY amount", [10]);
    expect(res.rows).toEqual([{ note: "coffee" }, { note: "books" }]);
  });

  it("refuses another project's table, however the query reaches it", () => {
    for (const sql of [
      "SELECT * FROM diary_entries",
      "SELECT note FROM budget_tx WHERE note IN (SELECT body FROM diary_entries)",
      "WITH d AS (SELECT body FROM diary_entries) SELECT * FROM d",
      'SELECT * FROM "diary_entries"',
      "SELECT b.note FROM budget_tx b JOIN diary_entries d ON d.id = b.id",
      // A view in the page's own project that reads someone else's table.
      "SELECT * FROM budget_peek",
    ]) {
      expect(() => pageQuery(ws.reader, bridge(), sql, []), sql).toThrow(/project "diary"'s/);
    }
  });

  it("refuses the schema, pragmas, KOS's own tables and other databases", () => {
    expect(() => pageQuery(ws.reader, bridge(), "SELECT name FROM sqlite_master", [])).toThrow(BridgeRefusal);
    expect(() => pageQuery(ws.reader, bridge(), "SELECT * FROM pragma_table_info('budget_tx')", [])).toThrow(/virtual table or a pragma/);
    expect(() => pageQuery(ws.reader, bridge(), "SELECT * FROM manifest", [])).toThrow(/not a project's/);
    expect(() => pageQuery(ws.reader, bridge(), "SELECT * FROM temp.sqlite_master", [])).toThrow(BridgeRefusal);
  });

  it("is read-only: a write in a query is refused before it runs, and the connection refuses it anyway", () => {
    expect(() => pageQuery(ws.reader, bridge(), "DELETE FROM budget_tx", [])).toThrow(/read-only/);
    expect(() => pageQuery(ws.reader, bridge(), "SELECT 1; DELETE FROM budget_tx", [])).toThrow(/read-only/);
    expect(() => ws.reader.prepare("DELETE FROM budget_tx").run()).toThrow(/readonly/i);
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM budget_tx").get()).toEqual({ n: 3 });
  });

  it("caps rows and time", () => {
    ws.db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 800) INSERT INTO budget_tx (amount) SELECT i FROM n");
    const capped = pageQuery(ws.reader, bridge(), "SELECT amount FROM budget_tx", []);
    expect(capped.rows).toHaveLength(500);
    expect(capped.truncated).toBe(true);
    let t = 0;
    const slow = pageQuery(ws.reader, bridge(), "SELECT amount FROM budget_tx", [], { now: () => (t += 1000) });
    expect(slow.timedOut).toBe(true);
  });

  it("honours a page that declares no queries", () => {
    expect(() => pageQuery(ws.reader, bridge({ capabilities: { query: false } }), "SELECT 1 FROM budget_tx", [])).toThrow(/does not declare queries/);
  });

  it("names the tables a query reads, from the plan", () => {
    expect(tablesRead(ws.reader, "SELECT b.note FROM budget_tx b WHERE b.id IN (SELECT id FROM budget_tx)", []).sort()).toEqual(["budget_tx"]);
  });

  it("writes only a declared table, its declared columns and operations", () => {
    const page = bridge({ capabilities: { writes: [{ table: "budget_tx", columns: ["amount", "note"], allow: ["insert", "update"] }] } });
    expect(pageWrite(ws.db, page, { table: "budget_tx", op: "insert", values: { amount: 3, note: "tea" } }).changes).toBe(1);
    expect(() => pageWrite(ws.db, page, { table: "diary_entries", op: "insert", values: { body: "x" } })).toThrow(/may write only "budget_tx"/);
    expect(() => pageWrite(ws.db, page, { table: "budget_tx", op: "insert", values: { secret: "x" } })).toThrow(/not editable/);
    expect(() => pageWrite(ws.db, page, { table: "budget_tx", op: "delete", key: { column: "id", value: 1 } })).toThrow(/not allowed/);
    expect(() => pageWrite(ws.db, bridge(), { table: "budget_tx", op: "insert", values: { amount: 1 } })).toThrow(/does not declare any writes/);
  });

  it("refuses a declared write to another project's table", () => {
    const page = bridge({ capabilities: { writes: [{ table: "diary_entries", columns: ["body"] }] } });
    expect(() => pageWrite(ws.db, page, { table: "diary_entries", op: "insert", values: { body: "x" } })).toThrow(/not this page's project's/);
  });

  it("reads files inside its own project only, when it declares it", () => {
    mkdirSync(join(root, "projects", "budget", "notes"), { recursive: true });
    writeFileSync(join(root, "projects", "budget", "notes", "plan.md"), "save more");
    mkdirSync(join(root, "projects", "diary"), { recursive: true });
    writeFileSync(join(root, "projects", "diary", "secret.md"), "no");
    const page = bridge({ capabilities: { files: true } });
    expect(pageFile(ws, page, "notes/plan.md")).toEqual({ path: "notes/plan.md", text: "save more", truncated: false });
    expect(() => pageFile(ws, page, "../diary/secret.md")).toThrow(/inside its own project/);
    expect(() => pageFile(ws, page, ".history/p/1.json")).toThrow(/history/);
    expect(() => pageFile(ws, bridge(), "notes/plan.md")).toThrow(/does not declare file reads/);
  });
});
