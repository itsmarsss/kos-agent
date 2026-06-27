import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { CronStore } from "../cron/store.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { cronModule } from "./cron.js";

describe("cronModule", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-crontool-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
    });
    await new ModuleLoader(ctx).load([cronModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("schedules an actions job (risky tier) and persists it", async () => {
    expect(registry.classify("cron.schedule", {}).tier).toBe("risky");
    const res = await registry.execute("cron.schedule", {
      name: "weekly",
      schedule: "0 9 * * 1",
      type: "actions",
      actions: [{ tool: "notify", args: { text: "hi" } }],
    });
    expect(res.isError).toBe(false);
    const store = new CronStore(ws.db);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.name).toBe("weekly");
  });

  it("rejects an invalid schedule", async () => {
    const res = await registry.execute("cron.schedule", {
      name: "bad",
      schedule: "not-a-cron",
      type: "actions",
      actions: [],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid cron schedule/);
  });

  it("lists and removes jobs (safe tier)", async () => {
    expect(registry.classify("cron.list", {}).tier).toBe("safe");
    await registry.execute("cron.schedule", {
      name: "j",
      schedule: "* * * * *",
      type: "self_prompt",
      prompt: "review",
    });
    const listed = JSON.parse((await registry.execute("cron.list", {})).content);
    expect(listed).toHaveLength(1);
    const id = listed[0].id;
    expect((await registry.execute("cron.remove", { id })).content).toBe("removed");
    expect(JSON.parse((await registry.execute("cron.list", {})).content)).toHaveLength(0);
  });
});
