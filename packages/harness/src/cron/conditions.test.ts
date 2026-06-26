import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { evaluateCondition, queryScope } from "./conditions.js";

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
      ws.db,
      "SELECT SUM(amount) AS total, COUNT(*) AS n FROM tx",
    );
    expect(scope).toEqual({ total: 220, n: 2 });
  });

  it("returns an empty scope for no query", () => {
    expect(queryScope(ws.db, null)).toEqual({});
  });

  it("evaluates a condition test over the query scope", () => {
    const query = "SELECT SUM(amount) AS total FROM tx";
    expect(evaluateCondition(ws.db, "total > 200", query)).toBe(true);
    expect(evaluateCondition(ws.db, "total > 500", query)).toBe(false);
  });

  it("treats a missing test as always-run", () => {
    expect(evaluateCondition(ws.db, null, null)).toBe(true);
  });

  it("evaluates a standalone boolean without a query", () => {
    expect(evaluateCondition(ws.db, "1 = 1", null)).toBe(true);
    expect(evaluateCondition(ws.db, "1 = 2", null)).toBe(false);
  });
});
