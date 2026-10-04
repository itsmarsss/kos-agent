import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { enabledServers } from "../modules/workspace.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createMcpModule } from "./mcp.js";
import { createModulesModule } from "./modules.js";

describe("modules tools", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let enabled: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-modtools-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    enabled = [];
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() });
    await createModulesModule({ enabled: () => enabled, status: () => ({}) }).activate(ctx);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("makes a module the owner can then switch on, and lists it off until they do", async () => {
    const made = await registry.execute("modules.create", { name: "hello", description: "Says hello" });
    expect(JSON.parse(made.content)).toMatchObject({ created: "modules/hello" });
    const list = JSON.parse((await registry.execute("modules.list", {})).content) as { modules: { name: string; enabled: boolean }[] };
    expect(list.modules).toEqual([expect.objectContaining({ name: "hello", enabled: false })]);
    expect(registry.classify("modules.create", {}).tier).toBe("safe");
  });

  it("scaffolds a server that really speaks the protocol", async () => {
    /*
     * The whole point of the template: the agent gets a module that works
     * before it writes a line. So run it, for real, over stdio, through the
     * same MCP module the kernel uses, and call the example tool.
     */
    await registry.execute("modules.create", { name: "hello", description: "Says hello" });
    const tools = new ToolRegistry();
    const mcp = createMcpModule({
      workspaceRoot: ws.root,
      secrets: new SecretsRegistry(),
      config: () => ({ servers: enabledServers(ws, ["hello"], false) }),
      report: () => undefined,
    });
    await mcp.activate(toolRegistryContext(tools));
    try {
      expect(mcp.status()).toEqual({ hello: { connected: true, tools: ["mcp.hello.greet"] } });
      expect(tools.classify("mcp.hello.greet", {}).tier).toBe("safe");
      const res = await tools.execute("mcp.hello.greet", { name: "Ada" });
      expect(res).toMatchObject({ isError: false, content: "Hello, Ada" });
    } finally {
      await mcp.deactivate!();
    }
    expect(tools.has("mcp.hello.greet")).toBe(false);
  }, 20_000);
});
