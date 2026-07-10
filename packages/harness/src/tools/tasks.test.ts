import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { InstanceConfig } from "../systems/config.js";
import { ProjectManifest } from "../systems/manifest.js";
import { Migrator } from "../systems/migrate.js";
import { PageStore } from "../systems/pages.js";
import { systemsModule } from "./systems.js";
import { tasksModule } from "./tasks.js";

describe("tasksModule", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let pages: PageStore;
  let manifest: ProjectManifest;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-tasks-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    manifest = new ProjectManifest(ws.db);
    const migrator = new Migrator(ws.db, manifest);
    pages = new PageStore(ws.db, ws, manifest);
    new InstanceConfig(ws.db);
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      manifest,
      migrator,
      pages,
    });
    await new ModuleLoader(ctx).load([systemsModule, tasksModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a list, adds items, completes, and writes a page", async () => {
    const created = await registry.execute("tasks.create_list", {
      name: "Errands",
      withPage: true,
    });
    expect(created.isError).toBe(false);
    const project = JSON.parse(created.content) as { slug: string };
    expect(project.slug).toBe("errands");

    const add = await registry.execute("tasks.add", {
      instance: "errands",
      title: "buy milk",
    });
    expect(add.isError).toBe(false);

    const list = await registry.execute("tasks.list", {
      instance: "errands",
    });
    const items = JSON.parse(list.content) as Array<{ title: string; id: number }>;
    expect(items.some((i) => i.title === "buy milk")).toBe(true);

    const id = items[0]!.id;
    const done = await registry.execute("tasks.complete", {
      instance: "errands",
      id,
    });
    expect(done.isError).toBe(false);

    expect(pages.list("errands").length).toBe(1);
    expect(manifest.listByModule("tasks")).toHaveLength(1);
  });

  it("create_list is idempotent for the same name", async () => {
    const a = await registry.execute("tasks.create_list", {
      name: "Tonight",
      withPage: true,
    });
    const b = await registry.execute("tasks.create_list", {
      name: "Tonight",
      withPage: true,
    });
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    const pa = JSON.parse(a.content) as { slug: string; alreadyExisted?: boolean };
    const pb = JSON.parse(b.content) as { slug: string; alreadyExisted?: boolean };
    expect(pa.slug).toBe("tonight");
    expect(pb.slug).toBe("tonight");
    expect(pb.alreadyExisted).toBe(true);
    expect(manifest.listByModule("tasks")).toHaveLength(1);
  });
});
