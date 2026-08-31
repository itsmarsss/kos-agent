import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { sqlModule } from "./sql.js";

describe("sqlModule", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-sql-"));
    ws = Workspace.open(root);
    ws.db.exec("CREATE TABLE tx (id INTEGER PRIMARY KEY, amount REAL)");
    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
    });
    await new ModuleLoader(ctx).load([sqlModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a parameterized SELECT and returns rows", async () => {
    ws.db.prepare("INSERT INTO tx (amount) VALUES (10), (20)").run();
    const res = await registry.execute("sql", {
      sql: "SELECT amount FROM tx WHERE amount > ? ORDER BY amount",
      params: [5],
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content)).toEqual([{ amount: 10 }, { amount: 20 }]);
  });

  it("runs a write and reports changes", async () => {
    const res = await registry.execute("sql", {
      sql: "INSERT INTO tx (amount) VALUES (?)",
      params: [99],
    });
    expect(JSON.parse(res.content).changes).toBe(1);
  });

  it("classifies SELECT safe and writes risky", () => {
    expect(registry.classify("sql", { sql: "SELECT 1" }).tier).toBe("safe");
    expect(registry.classify("sql", { sql: "DELETE FROM tx" }).tier).toBe("risky");
  });

  it("rejects DDL (must use migrate)", async () => {
    const res = await registry.execute("sql", { sql: "DROP TABLE tx" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/migrate/);
  });

  it("rejects stacked statements", async () => {
    const res = await registry.execute("sql", {
      sql: "SELECT 1; DELETE FROM tx",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/multiple statements/);
  });
});

describe("missing table errors", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-sqlerr-"));
    ws = Workspace.open(root);
    ws.db.exec(`CREATE TABLE budget_tracker_expenses (id INTEGER PRIMARY KEY)`);
    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
    });
    await new ModuleLoader(ctx).load([sqlModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("suggests the physical table when given the dotted name", async () => {
    // A cron kept failing every minute on "no such table:
    // budget_tracker.expenses", which is true and tells the model nothing.
    const res = await registry.execute("sql", {
      sql: "SELECT * FROM 'budget_tracker.expenses'",
    });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Did you mean "budget_tracker_expenses"');
  });

  it("says tables are namespaced when given the logical name", async () => {
    const res = await registry.execute("sql", { sql: "SELECT * FROM expenses" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('use "budget_tracker_expenses"');
  });

  it("lists what exists when the name resembles nothing", async () => {
    const res = await registry.execute("sql", { sql: "SELECT * FROM nonsense" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("budget_tracker_expenses");
  });
});
