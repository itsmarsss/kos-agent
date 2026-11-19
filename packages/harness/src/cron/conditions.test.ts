import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { evaluateCondition, queryScope, readerOf } from "./conditions.js";

describe("cron conditions and scope", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-cron-cond-"));
    ws = Workspace.open(root);
    ws.db.exec("CREATE TABLE tx (amount REAL)");
    ws.db.prepare("INSERT INTO tx (amount) VALUES (120), (100)").run();
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the first query row as the scope", () => {
    const scope = queryScope(
      readerOf(ws.db),
      "SELECT SUM(amount) AS total, COUNT(*) AS n FROM tx",
    );
    expect(scope).toEqual({ total: 220, n: 2 });
  });

  it("returns an empty scope for no query", () => {
    expect(queryScope(readerOf(ws.db), null)).toEqual({});
  });

  it("evaluates a condition test over the query scope", () => {
    const query = "SELECT SUM(amount) AS total FROM tx";
    expect(evaluateCondition(readerOf(ws.db), "total > 200", query)).toBe(true);
    expect(evaluateCondition(readerOf(ws.db), "total > 500", query)).toBe(false);
  });

  it("treats a missing test as always-run", () => {
    expect(evaluateCondition(readerOf(ws.db), null, null)).toBe(true);
  });

  it("evaluates a standalone boolean without a query", () => {
    expect(evaluateCondition(readerOf(ws.db), "1 = 1", null)).toBe(true);
    expect(evaluateCondition(readerOf(ws.db), "1 = 2", null)).toBe(false);
  });

  it("runs nothing but one read, and nothing its check refuses, the test as spliced included", () => {
    const read = readerOf(ws.db);
    expect(() => queryScope(read, "DELETE FROM tx")).toThrow(/reads/);
    expect(() => evaluateCondition(read, "1); DELETE FROM tx; SELECT (1", null)).toThrow(/reads/);
    const seen: string[] = [];
    const fenced = readerOf(ws.db, (sql) => {
      seen.push(sql);
      if (/secret/i.test(sql)) throw new Error("refused");
    });
    expect(() => evaluateCondition(fenced, "(SELECT 1 FROM secret)", "SELECT 1 AS x")).toThrow(/refused/);
    expect(seen).toEqual(["SELECT ((SELECT 1 FROM secret)) AS pass FROM (SELECT 1 AS x)"]);
  });
});
