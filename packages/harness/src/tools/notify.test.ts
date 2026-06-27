import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { notifyModule } from "./notify.js";

describe("notifyModule", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-notify-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function load(notify?: (t: string) => Promise<void>): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      ...(notify ? { notify } : {}),
    });
    await new ModuleLoader(ctx).load([notifyModule]);
    return registry;
  }

  it("sends via the wired channel and is safe-tier", async () => {
    const sent: string[] = [];
    const registry = await load(async (t) => {
      sent.push(t);
    });
    const res = await registry.execute("notify", { text: "hello" });
    expect(res.isError).toBe(false);
    expect(sent).toEqual(["hello"]);
    expect(registry.classify("notify", { text: "x" }).tier).toBe("safe");
  });

  it("errors when no channel is wired", async () => {
    const registry = await load();
    const res = await registry.execute("notify", { text: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no notify channel/);
  });
});
