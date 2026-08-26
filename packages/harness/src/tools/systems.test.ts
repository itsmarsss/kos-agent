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
    });
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

  it("still rejects a malformed spec at execution", async () => {
    const res = await registry.execute("systems.migrate", {
      project: "budget",
      spec: { table: "tx" },
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/op/);
  });
});
