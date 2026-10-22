import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext, type ModuleServices } from "../modules/loader.js";
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
    ws.db.exec("CREATE TABLE books_tx (id INTEGER PRIMARY KEY, amount REAL)");
    ws.db.exec("CREATE TABLE garden_beds (id INTEGER PRIMARY KEY)");
    registry = await harness("books");
  });

  /** The sql tool as one chat sees it: the caller's project, and the projects that exist. */
  async function harness(project: string | undefined): Promise<ToolRegistry> {
    const made = new ToolRegistry();
    const manifest = { list: () => [{ slug: "books", name: "Books" }, { slug: "garden", name: "Garden" }, { slug: "maintenance", name: "Maintenance" }] } as unknown as NonNullable<ModuleServices["manifest"]>;
    const ctx = toolRegistryContext(made, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), manifest, ...(project ? { callerProject: () => project } : {}) });
    await new ModuleLoader(ctx).load([sqlModule]);
    return made;
  }

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a parameterized SELECT and returns rows", async () => {
    ws.db.prepare("INSERT INTO books_tx (amount) VALUES (10), (20)").run();
    const res = await registry.execute("sql", {
      sql: "SELECT amount FROM books_tx WHERE amount > ? ORDER BY amount",
      params: [5],
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content)).toEqual([{ amount: 10 }, { amount: 20 }]);
  });

  it("runs a write and reports changes", async () => {
    const res = await registry.execute("sql", {
      sql: "INSERT INTO books_tx (amount) VALUES (?)",
      params: [99],
    });
    expect(JSON.parse(res.content).changes).toBe(1);
  });

  it("classifies SELECT and INSERT safe, UPDATE and DELETE risky", () => {
    expect(registry.classify("sql", { sql: "SELECT 1" }).tier).toBe("safe");
    expect(registry.classify("sql", { sql: "INSERT INTO books_tx (a) VALUES (1)" }).tier).toBe("safe");
    expect(registry.classify("sql", { sql: "UPDATE books_tx SET a = 2" }).tier).toBe("risky");
    expect(registry.classify("sql", { sql: "DELETE FROM books_tx" }).tier).toBe("risky");
  });

  it("refuses KOS's own tables outside Maintenance, and the trust tables everywhere", async () => {
    ws.db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT)");
    ws.db.exec("CREATE TABLE pending_actions (id INTEGER PRIMARY KEY, status TEXT)");
    ws.db.prepare("INSERT INTO conversations (id, title) VALUES ('c1', 'Main')").run();
    const read = await registry.execute("sql", { sql: "SELECT * FROM conversations" });
    expect(read.isError).toBe(true);
    expect(read.content).toMatch(/KOS's own/);
    // The schema is not a project's to list.
    const listed = await registry.execute("sql", { sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" });
    expect(listed.isError).toBe(true);
    expect(listed.content).toMatch(/schema is Maintenance's to read/);
    // The same, asked from Maintenance: reads allowed, the trust tables still not written.
    const maintenance = await harness("maintenance");
    expect(JSON.parse((await maintenance.execute("sql", { sql: "SELECT title FROM conversations" })).content)).toEqual([{ title: "Main" }]);
    const trust = await maintenance.execute("sql", { sql: "UPDATE pending_actions SET status = 'approved'" });
    expect(trust.isError).toBe(true);
    expect(trust.content).toMatch(/trust tables/);
    expect(JSON.parse((await maintenance.execute("sql", { sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" })).content).map((r: { name: string }) => r.name)).toEqual(["books_tx", "conversations", "garden_beds", "pending_actions"]);
  });

  it("reaches another project's table only from Maintenance, and no table from a chat with no project", async () => {
    const theirs = await registry.execute("sql", { sql: "SELECT * FROM garden_beds" });
    expect(theirs.isError).toBe(true);
    expect(theirs.content).toMatch(/garden_beds is the Garden project's, not this project's/);
    expect(theirs.content).toMatch(/@project:maintenance/);
    const loose = await harness(undefined);
    const nothing = await loose.execute("sql", { sql: "SELECT * FROM books_tx" });
    expect(nothing.isError).toBe(true);
    expect(nothing.content).toMatch(/books_tx is the Books project's/);
    expect(nothing.content).toMatch(/ask KOS at the root/);
    expect((await loose.execute("sql", { sql: "SELECT 1 AS n" })).isError).toBe(false);
    const maintenance = await harness("maintenance");
    expect((await maintenance.execute("sql", { sql: "SELECT * FROM garden_beds" })).isError).toBe(false);
  });

  it("rejects DDL (must use migrate)", async () => {
    const res = await registry.execute("sql", { sql: "DROP TABLE books_tx" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/migrate/);
  });

  it("rejects stacked statements", async () => {
    const res = await registry.execute("sql", {
      sql: "SELECT 1; DELETE FROM books_tx",
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
    ws.db.exec(`CREATE TABLE books_items (id INTEGER PRIMARY KEY)`);
    registry = await scoped("budget_tracker");
  });

  async function scoped(project: string | undefined): Promise<ToolRegistry> {
    const made = new ToolRegistry();
    const manifest = { list: () => [{ slug: "budget_tracker", name: "Budget" }, { slug: "books", name: "Books" }] } as unknown as NonNullable<ModuleServices["manifest"]>;
    const ctx = toolRegistryContext(made, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), manifest, ...(project ? { callerProject: () => project } : {}) });
    await new ModuleLoader(ctx).load([sqlModule]);
    return made;
  }

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

  it("lists the project's own tables when the name resembles nothing, and points on", async () => {
    const res = await registry.execute("sql", { sql: "SELECT * FROM nonsense" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("This project's tables: budget_tracker_expenses");
    expect(res.content).not.toContain("books_items");
    expect(res.content).toContain("@project:maintenance");
  });

  it("says whose a table is when another project's was named, and that a loose chat has none", async () => {
    const theirs = await registry.execute("sql", { sql: "SELECT * FROM items" });
    expect(theirs.isError).toBe(true);
    expect(theirs.content).toMatch(/That is the Books project's table, not this chat's/);
    expect(theirs.content).toContain("@project:books");
    const loose = await scoped(undefined);
    const none = await loose.execute("sql", { sql: "SELECT * FROM nonsense" });
    expect(none.content).toMatch(/belongs to no project, so no table is its to read/);
    // Maintenance is shown everything, as before.
    const maintenance = await scoped("maintenance");
    expect((await maintenance.execute("sql", { sql: "SELECT * FROM nonsense" })).content).toContain("Tables in this workspace: books_items, budget_tracker_expenses");
  });
});
