import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HtmlPage } from "@kos/shared";

import { DB_FILENAME, Workspace } from "../store/workspace.js";
import { ProjectManifest } from "./manifest.js";
import { Migrator } from "./migrate.js";
import { BridgeRefusal, pageFile, pageQuery, pageWrite, tablesRead, type BridgePage } from "./pagebridge.js";
import { PageQueries } from "./pagequeries.js";
import { registeredTables } from "./registered.js";

/**
 * What an HTML page reaches through window.kos, which is everything it can
 * reach: the tables its project made, read-only and bounded; the tables it
 * declared, written through the guarded path; and its own project's files.
 */
describe("the page bridge", () => {
  let root: string;
  let ws: Workspace;
  let queries: PageQueries;

  const bridge = (page: Partial<HtmlPage> = {}, projectSlug = "budget"): BridgePage => ({
    page: { id: "p", title: "P", html: "<p>x</p>", ...page },
    projectSlug,
    tables: registeredTables(ws.db, projectSlug),
  });
  const query = (b: BridgePage, sql: string, params: unknown[] = [], options = {}) => pageQuery(ws.reader, queries, b, sql, params, options);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-bridge-"));
    ws = Workspace.open(root);
    const manifest = new ProjectManifest(ws.db);
    const migrator = new Migrator(ws.db, manifest);
    manifest.createProject({ name: "Budget", type: "tracker" });
    manifest.createProject({ name: "Diary", type: "notes" });
    migrator.migrate("budget", {
      op: "create_table",
      table: "tx",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "amount", type: "REAL" },
        { name: "note", type: "TEXT" },
        { name: "secret", type: "TEXT" },
        { name: "done", type: "INTEGER" },
      ],
    });
    migrator.migrate("diary", { op: "create_table", table: "entries", columns: [{ name: "id", type: "INTEGER", primaryKey: true }, { name: "body", type: "TEXT" }] });
    ws.db.exec(`
      CREATE VIEW budget_peek AS SELECT body FROM diary_entries;
      INSERT INTO budget_tx (amount, note) VALUES (12.5, 'coffee'), (40, 'books'), (7, 'bus');
      INSERT INTO diary_entries (body) VALUES ('private');
    `);
    queries = new PageQueries(join(ws.root, DB_FILENAME));
  });

  afterEach(() => {
    queries.close();
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the page's own tables, with parameters", async () => {
    const res = await query(bridge(), "SELECT note FROM budget_tx WHERE amount > ? ORDER BY amount", [10]);
    expect(res.rows).toEqual([{ note: "coffee" }, { note: "books" }]);
  });

  it("refuses another project's table, however the query reaches it", async () => {
    for (const sql of [
      "SELECT * FROM diary_entries",
      "SELECT note FROM budget_tx WHERE note IN (SELECT body FROM diary_entries)",
      "WITH d AS (SELECT body FROM diary_entries) SELECT * FROM d",
      'SELECT * FROM "diary_entries"',
      "SELECT b.note FROM budget_tx b JOIN diary_entries d ON d.id = b.id",
      // A view in the page's own project that reads someone else's table.
      "SELECT * FROM budget_peek",
    ]) {
      await expect(query(bridge(), sql), sql).rejects.toThrow(/reads only this project's tables/);
    }
  });

  it("refuses the schema, pragmas, KOS's own tables and other databases", async () => {
    for (const sql of ["SELECT name FROM sqlite_master", "SELECT * FROM pragma_table_info('budget_tx')", "SELECT * FROM manifest", "SELECT * FROM temp.sqlite_master"]) {
      await expect(query(bridge(), sql), sql).rejects.toThrow(BridgeRefusal);
    }
  });

  /*
   * Tables are named <slug>_<table>, so a project whose slug prefixes one of
   * KOS's own tables owned it by name: "Permission" reached permission_rules.
   */
  it("reaches only the tables its project made, never one its slug merely prefixes", async () => {
    const manifest = new ProjectManifest(ws.db);
    // A project made before KOS's table existed keeps the clashing slug.
    manifest.createProject({ name: "Permission", type: "notes" });
    ws.db.exec(`CREATE TABLE permission_rules (id INTEGER PRIMARY KEY, rule TEXT); INSERT INTO permission_rules (rule) VALUES ('allow all')`);
    const hostile = bridge({ capabilities: { writes: [{ table: "permission_rules", columns: ["rule"] }] } }, "permission");
    expect(hostile.tables.size).toBe(0);
    await expect(query(hostile, "SELECT rule FROM permission_rules")).rejects.toThrow(/reads only this project's tables/);
    expect(() => pageWrite(ws.db, hostile, { table: "permission_rules", op: "insert", values: { rule: "x" } })).toThrow(/only its own project's tables/);
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM permission_rules").get()).toEqual({ n: 1 });
  });

  it("answers a missing table and another project's table the same way", async () => {
    const words = async (sql: string) => (await query(bridge(), sql).catch((e: Error) => e)) as Error;
    const missing = await words("SELECT * FROM budget_nothing");
    const foreign = await words("SELECT * FROM diary_entries");
    const kernel = await words("SELECT * FROM manifest");
    // A column that is not there would otherwise say the table is.
    const column = await words("SELECT nothing FROM diary_entries");
    expect(missing).toBeInstanceOf(BridgeRefusal);
    expect(new Set([missing.message, foreign.message, kernel.message, column.message]).size).toBe(1);
    expect(missing.message).not.toMatch(/no such|diary|budget_nothing/);
    const write = (() => {
      try {
        pageWrite(ws.db, bridge({ capabilities: { writes: [{ table: "diary_entries", columns: ["body"] }] } }), { table: "diary_entries", op: "insert", values: { body: "x" } });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(write?.message).not.toMatch(/diary"|project "/);
  });

  it("is read-only: a write in a query is refused before it runs, and the connection refuses it anyway", async () => {
    await expect(query(bridge(), "DELETE FROM budget_tx")).rejects.toThrow(/read-only/);
    await expect(query(bridge(), "SELECT 1; DELETE FROM budget_tx")).rejects.toThrow(/read-only/);
    expect(() => ws.reader.prepare("DELETE FROM budget_tx").run()).toThrow(/readonly/i);
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM budget_tx").get()).toEqual({ n: 3 });
  });

  it("caps rows", async () => {
    ws.db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 800) INSERT INTO budget_tx (amount) SELECT i FROM n");
    const capped = await query(bridge(), "SELECT amount FROM budget_tx");
    expect(capped.rows).toHaveLength(500);
    expect(capped.truncated).toBe(true);
  });

  /*
   * SQLite cannot be interrupted from Node, so a query that never ends ran on
   * the server's thread until it did. It runs apart now and is killed.
   */
  it("stops a query that never ends, and the server's thread stays free", async () => {
    let ticks = 0;
    const tick = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    const never = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n, budget_tx";
    await expect(query(bridge(), never, [], { timeoutMs: 600 })).rejects.toThrow(/ran past 600 ms/);
    clearInterval(tick);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ticks).toBeGreaterThan(10);
    // The killed runner is replaced: the next query is answered.
    expect((await query(bridge(), "SELECT COUNT(*) AS n FROM budget_tx")).rows).toEqual([{ n: 3 }]);
  });

  it("honours a page that declares no queries", async () => {
    await expect(query(bridge({ capabilities: { query: false } }), "SELECT 1 FROM budget_tx")).rejects.toThrow(/does not declare queries/);
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

  it("writes true and false as 1 and 0, and refuses objects and lists", () => {
    const page = bridge({ capabilities: { writes: [{ table: "budget_tx", columns: ["note", "done"] }] } });
    pageWrite(ws.db, page, { table: "budget_tx", op: "insert", values: { note: "tick", done: true } });
    pageWrite(ws.db, page, { table: "budget_tx", op: "update", key: { column: "note", value: "tick" }, values: { done: false } });
    expect(ws.db.prepare("SELECT done FROM budget_tx WHERE note = 'tick'").get()).toEqual({ done: 0 });
    pageWrite(ws.db, page, { table: "budget_tx", op: "update", key: { column: "done", value: false }, values: { note: "ticked" } });
    expect(ws.db.prepare("SELECT COUNT(*) AS n FROM budget_tx WHERE note = 'ticked'").get()).toEqual({ n: 1 });
    expect(() => pageWrite(ws.db, page, { table: "budget_tx", op: "insert", values: { note: { a: 1 } } })).toThrow(BridgeRefusal);
    expect(() => pageWrite(ws.db, page, { table: "budget_tx", op: "insert", values: { note: [1] } })).toThrow(/values.note must be/);
    expect(() => pageWrite(ws.db, page, { table: "budget_tx", op: "insert", values: [1] })).toThrow(BridgeRefusal);
    expect(() => pageWrite(ws.db, page, { table: "budget_tx", op: "delete", key: { column: "id", value: { x: 1 } } })).toThrow(/key.value must be/);
  });

  it("reads files inside its own project only, when it declares it, and never its pages", () => {
    mkdirSync(join(root, "projects", "budget", "notes", ".history"), { recursive: true });
    writeFileSync(join(root, "projects", "budget", "notes", "plan.md"), "save more");
    writeFileSync(join(root, "projects", "budget", "notes", ".history", "old.md"), "old");
    mkdirSync(join(root, "projects", "budget", "pages", ".history", "p"), { recursive: true });
    writeFileSync(join(root, "projects", "budget", "pages", "other.html"), "<p>another page</p>");
    writeFileSync(join(root, "projects", "budget", "pages", ".history", "p", "1.json"), "{}");
    mkdirSync(join(root, "projects", "diary"), { recursive: true });
    writeFileSync(join(root, "projects", "diary", "secret.md"), "no");
    const page = bridge({ capabilities: { files: true } });
    expect(pageFile(ws, page, "notes/plan.md")).toEqual({ path: "notes/plan.md", text: "save more", truncated: false });
    expect(() => pageFile(ws, page, "../diary/secret.md")).toThrow(/inside its own project/);
    for (const path of ["pages/.history/p/1.json", "pages/other.html", "./pages/other.html", "notes/.history/old.md"]) {
      expect(() => pageFile(ws, page, path), path).toThrow(/pages or their history/);
    }
    expect(() => pageFile(ws, bridge(), "notes/plan.md")).toThrow(/does not declare file reads/);
  });

  it("reads only the start of a large file", () => {
    mkdirSync(join(root, "projects", "budget"), { recursive: true });
    writeFileSync(join(root, "projects", "budget", "big.txt"), "x".repeat(300_000));
    const got = pageFile(ws, bridge({ capabilities: { files: true } }), "big.txt");
    expect(got.text).toHaveLength(256_000);
    expect(got.truncated).toBe(true);
  });
});
