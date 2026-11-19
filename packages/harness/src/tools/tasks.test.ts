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
  let migrator: Migrator;
  /** The project the calling chat is in, and what its turn made. */
  let caller: string | undefined;
  let made: string[];

  /** A registry whose calls come from a chat in `project`. */
  async function chatIn(project: string): Promise<ToolRegistry> {
    const other = new ToolRegistry();
    const ctx = toolRegistryContext(other, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), manifest, migrator, pages, callerProject: () => project });
    await new ModuleLoader(ctx).load([tasksModule]);
    return other;
  }

  beforeEach(async () => {
    caller = undefined;
    made = [];
    root = mkdtempSync(join(tmpdir(), "kos-tasks-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    manifest = new ProjectManifest(ws.db);
    migrator = new Migrator(ws.db, manifest);
    pages = new PageStore(ws.db, ws, manifest);
    new InstanceConfig(ws.db);
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      manifest,
      migrator,
      pages,
      callerProject: () => caller,
      turnMade: { note: (slug: string) => void made.push(slug), made: () => made },
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

  it("reaches a list only from its own chats, the turn that made it, or Maintenance", async () => {
    await registry.execute("tasks.create_list", { name: "Errands", withPage: false });
    await registry.execute("tasks.add", { instance: "errands", title: "buy milk" });
    // A later turn at the root still reaches it: the root reaches every list.
    made = [];
    expect(JSON.parse((await registry.execute("tasks.list", { instance: "errands" })).content)).toHaveLength(1);

    manifest.createProject({ name: "Other", type: "notes" });
    const other = await chatIn("other");
    for (const [tool, input] of [
      ["tasks.add", { instance: "errands", title: "planted" }],
      ["tasks.list", { instance: "errands" }],
      ["tasks.complete", { instance: "errands", id: 1 }],
      ["tasks.create_list", { name: "Sneaky" }],
    ] as const) {
      expect((await other.execute(tool, input)).isError, `${tool} ${JSON.stringify(input)}`).toBe(true);
    }
    // Not a list at all: another project's own tables are never made or filled here.
    expect((await other.execute("tasks.add", { instance: "other", title: "x" })).isError).toBe(true);
    expect(ws.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%other%items%'").all()).toEqual([]);

    const own = await chatIn("errands");
    const items = JSON.parse((await own.execute("tasks.list", { instance: "errands" })).content) as { title: string }[];
    expect(items.map((i) => i.title)).toEqual(["buy milk"]);
    expect((await (await chatIn("maintenance")).execute("tasks.list", { instance: "errands" })).isError).toBe(false);
  });

  it("lets a later root turn and a root schedule add to and tick off a list", async () => {
    await registry.execute("tasks.create_list", { name: "Groceries", withPage: false });
    made = [];
    // Another day, at the root: nothing made this turn.
    expect((await registry.execute("tasks.add", { instance: "groceries", title: "milk" })).isError).toBe(false);
    // A root schedule's thread: no project, no blob, no guest.
    const cron = new ToolRegistry();
    const ctx = toolRegistryContext(cron, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), manifest, migrator, pages, callerConversation: () => "cron:7" });
    await new ModuleLoader(ctx).load([tasksModule]);
    const [item] = JSON.parse((await cron.execute("tasks.list", { instance: "groceries" })).content) as { id: number }[];
    expect((await cron.execute("tasks.complete", { instance: "groceries", id: item!.id })).isError).toBe(false);
    // A blob at the root is still held to its own.
    const blob = new ToolRegistry();
    await new ModuleLoader(toolRegistryContext(blob, { workspace: ws, db: ws.db, secrets: new SecretsRegistry(), manifest, migrator, pages, callerBlob: () => ({ name: "helper", id: "b1" }) })).load([tasksModule]);
    expect((await blob.execute("tasks.list", { instance: "groceries" })).isError).toBe(true);
  });
});
