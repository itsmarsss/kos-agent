import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { ProjectManifest } from "../systems/manifest.js";
import { Migrator } from "../systems/migrate.js";
import { PageStore } from "../systems/pages.js";
import { systemsModule } from "./systems.js";

/**
 * The migrate tool's tier is tool plus arguments: a multi-step build
 * (project_create, migrate, migrate, pages.write) must run end to end without
 * an approval stop, while destructive schema edits still queue.
 */

describe("systems.migrate risk", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  // The chat calling, and the project it belongs to: the chat that makes a project may build it.
  let caller = "c1";
  let callerProject: string | undefined;
  // What the running turn made: the kernel opens it per turn and drops it at the end.
  let made = new Set<string>();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-systems-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    const manifest = new ProjectManifest(ws.db);
    const migrator = new Migrator(ws.db, manifest);
    const pages = new PageStore(ws.db, ws, manifest);
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      manifest,
      migrator,
      pages,
      callerConversation: () => caller,
      callerProject: () => callerProject,
      turnMade: { note: (slug) => made.add(slug), made: () => [...made] },
    });
    caller = "c1";
    callerProject = undefined;
    made = new Set();
    await new ModuleLoader(ctx).load([systemsModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const safeOps: Array<{ name: string; spec: unknown }> = [
    {
      name: "create_table",
      spec: {
        op: "create_table",
        table: "tx",
        columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
      },
    },
    {
      name: "add_column",
      spec: { op: "add_column", table: "tx", column: { name: "note", type: "TEXT" } },
    },
    {
      name: "create_index",
      spec: { op: "create_index", table: "tx", columns: ["id"] },
    },
  ];

  for (const c of safeOps) {
    it(`classifies ${c.name} safe`, () => {
      const got = registry.classify("systems.migrate", { project: "budget", spec: c.spec });
      expect(got.tier).toBe("safe");
      expect(got.escalated).toBe(false);
    });
  }

  const riskyOps: Array<{ name: string; spec: unknown }> = [
    { name: "drop_column", spec: { op: "drop_column", table: "tx", column: "note" } },
    {
      name: "rename_column",
      spec: { op: "rename_column", table: "tx", from: "note", to: "memo" },
    },
    { name: "rename_table", spec: { op: "rename_table", from: "tx", to: "ledger" } },
    { name: "an unknown op", spec: { op: "drop_table", table: "tx" } },
    { name: "a malformed spec", spec: "create_table" },
    { name: "a null spec", spec: null },
  ];

  for (const c of riskyOps) {
    it(`escalates ${c.name} to risky`, () => {
      const got = registry.classify("systems.migrate", { project: "budget", spec: c.spec });
      expect(got.tier).toBe("risky");
      expect(got.escalated).toBe(true);
    });
  }

  it("escalates a missing spec", () => {
    expect(registry.classify("systems.migrate", { project: "budget" }).tier).toBe("risky");
  });

  it("runs a project build without an approval stop", async () => {
    const created = await registry.execute("systems.project_create", {
      name: "Budget",
      type: "tracker",
    });
    expect(created.isError).toBe(false);
    const { slug } = JSON.parse(created.content) as { slug: string };

    const steps: unknown[] = [
      {
        op: "create_table",
        table: "tx",
        columns: [
          { name: "id", type: "INTEGER", primaryKey: true },
          { name: "amount", type: "REAL" },
        ],
      },
      { op: "add_column", table: "tx", column: { name: "category", type: "TEXT" } },
      { op: "create_index", table: "tx", columns: ["category"] },
    ];

    for (const spec of steps) {
      const args = { project: slug, spec };
      expect(registry.classify("systems.migrate", args).tier).toBe("safe");
      const res = await registry.execute("systems.migrate", args);
      expect(res.isError).toBe(false);
    }

    const cols = ws.db.prepare(`SELECT * FROM budget_tx`).all();
    expect(cols).toEqual([]);
  });

  it("lets a project's schema be changed by the turn that made it, its own chats and Maintenance, and no one else", async () => {
    const created = await registry.execute("systems.project_create", { name: "Garden", type: "tracker" });
    const { slug } = JSON.parse(created.content) as { slug: string };
    const args = { project: slug, spec: { op: "create_table", table: "beds", columns: [{ name: "id", type: "INTEGER", primaryKey: true }] } };
    expect((await registry.execute("systems.migrate", args)).isError).toBe(false);
    // The turn is over: the same chat, a turn later, has no reach left.
    made = new Set();
    expect((await registry.execute("systems.migrate", { ...args, spec: { ...args.spec, table: "rows" } })).content).toMatch(/@project:garden/);
    caller = "c2";
    const loose = await registry.execute("systems.migrate", args);
    expect(loose.isError).toBe(true);
    expect(loose.content).toMatch(/This chat belongs to no project, so Garden's tables are not its to change.*@project:garden/);
    callerProject = "pantry";
    expect((await registry.execute("systems.migrate", args)).content).toMatch(/This chat is pantry's, so Garden's tables/);
    callerProject = slug;
    expect((await registry.execute("systems.migrate", { ...args, spec: { ...args.spec, table: "plots" } })).isError).toBe(false);
    callerProject = "maintenance";
    expect((await registry.execute("systems.migrate", { ...args, spec: { op: "add_column", table: "beds", column: { name: "note", type: "TEXT" } } })).isError).toBe(false);
  });

  it("still rejects a malformed spec at execution", async () => {
    const res = await registry.execute("systems.migrate", {
      project: "budget",
      spec: { table: "tx" },
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/op/);
  });

  it("writes an HTML page through pages.write, keeps the older spec form, and rolls back", async () => {
    const created = await registry.execute("systems.project_create", { name: "Budget", type: "tracker" });
    const { slug } = JSON.parse(created.content) as { slug: string };
    const html = await registry.execute("pages.write", { project: slug, id: "home", title: "Home", html: "<h1>Hi</h1>" });
    expect(html.isError).toBe(false);
    expect(JSON.parse(html.content)).toMatchObject({ kind: "html" });
    const spec = await registry.execute("pages.write", { project: slug, spec: { id: "old", title: "Old", widgets: [{ type: "markdown", content: "x" }] } });
    expect(JSON.parse(spec.content)).toMatchObject({ kind: "spec" });
    await registry.execute("pages.write", { project: slug, id: "home", title: "Home", html: "<h1>Two</h1>" });
    const history = JSON.parse((await registry.execute("pages.history", { id: "home" })).content) as { version: number }[];
    expect(history.map((v) => v.version)).toEqual([1, 2]);
    await registry.execute("pages.rollback", { id: "home", version: 1 });
    const got = JSON.parse((await registry.execute("pages.get", { id: "home" })).content) as { page: { html: string } };
    expect(got.page.html).toBe("<h1>Hi</h1>");
  });
});
