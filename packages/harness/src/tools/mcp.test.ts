import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolRegistry } from "../agent/registry.js";
import { toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import {
  createMcpModule,
  floorFor,
  mcpToolName,
  parseMcpConfig,
  renderContent,
  type McpConfig,
} from "./mcp.js";

/**
 * A real MCP server, in this process, over the SDK's in-memory transport.
 *
 * Nothing is spawned. The module is exercised against the actual protocol
 * rather than a stub of it, which is what caught the difference between a
 * tool's result content and its error flag.
 */
function fakeServer(): { transport: () => InMemoryTransport; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  // One server per connection: a protocol object holds a single transport,
  // so two "servers" sharing an instance left the second client waiting
  // forever for an initialize reply.
  const build = (): McpServer => {
    const server = new McpServer({ name: "fake", version: "0.0.0" });
    server.registerTool(
      "add",
      { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
      async ({ a, b }) => {
        seen.push({ a, b });
        return { content: [{ type: "text", text: String(a + b) }] };
      },
    );
    server.registerTool(
      "explode",
      { description: "Always fails", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
    );
    server.registerTool(
      "picture",
      { description: "Returns an image", inputSchema: {} },
      async () => ({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
    );
    return server;
  };
  return {
    seen,
    transport: () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      void build().connect(serverSide);
      return client;
    },
  };
}

function harness(config: McpConfig, fake = fakeServer()) {
  const registry = new ToolRegistry();
  const reports: string[] = [];
  const module = createMcpModule({
    workspaceRoot: "/tmp/kos-mcp-test",
    secrets: new SecretsRegistry(),
    config: () => config,
    transportFor: (name) => (name === "broken" ? undefined : fake.transport()),
    report: (m) => reports.push(m),
  });
  // Letting go is the module's own deactivate now, not a second handle.
  const close = async (): Promise<void> => { await module.deactivate!(); };
  return { registry, module, close, reports, fake };
}

describe("naming and reading config", () => {
  it("names a server's tool so it cannot collide with a first-party one", () => {
    expect(mcpToolName("My Server", "do-thing")).toBe("mcp.my_server.do_thing");
  });

  it("keeps only entries with exactly one transport", () => {
    const config = parseMcpConfig({
      servers: {
        stdio: { command: "node", args: ["s.js"] },
        http: { url: "http://localhost:9/mcp" },
        both: { command: "x", url: "http://y" },
        neither: { enabled: true },
      },
    });
    expect(Object.keys(config.servers).sort()).toEqual(["http", "stdio"]);
  });

  it("renders what a call produced as text the model can read", () => {
    expect(renderContent([{ type: "text", text: "hi" }])).toBe("hi");
    expect(renderContent([{ type: "image", mimeType: "image/png" }])).toBe("[image image/png]");
    expect(renderContent([{ type: "resource", resource: { uri: "file:///a" } }])).toBe("[resource file:///a]");
  });
});

describe("a floor per tool", () => {
  it("takes an exact tool floor over a glob over the server default", () => {
    const server = {
      command: "x",
      risk: "risky" as const,
      tools: { browser_navigate: "safe" as const, "browser_*": "risky" as const, "*_get": "safe" as const },
    };
    expect(floorFor(server, "browser_navigate")).toBe("safe");
    expect(floorFor(server, "browser_click")).toBe("risky");
    expect(floorFor(server, "cookie_get")).toBe("safe");
    expect(floorFor(server, "cookie_set")).toBe("risky");
  });

  it("falls back to the server default, then to risky", () => {
    expect(floorFor({ command: "x", risk: "safe" }, "anything")).toBe("safe");
    expect(floorFor({ command: "x" }, "anything")).toBe("risky");
  });

  it("floors the documented mail server as the README says", () => {
    // The config in README's Mail section, verbatim in shape: reads safe,
    // everything that changes or sends mail left at the risky default.
    const config = parseMcpConfig({
      servers: {
        mail: {
          command: "npx",
          args: ["-y", "@aiwerk/mcp-server-imap"],
          env: { IMAP_HOST: "imap.example.com", IMAP_USER: "you@example.com", IMAP_PASS: "{{secret:mail}}" },
          tools: {
            email_list: "safe", email_read: "safe", email_search: "safe",
            email_folders: "safe", email_attachment: "safe",
          },
        },
      },
    });
    const mail = config.servers.mail!;
    for (const read of ["email_list", "email_read", "email_search", "email_folders", "email_attachment"]) {
      expect(floorFor(mail, read)).toBe("safe");
    }
    for (const write of ["email_move", "email_flag", "email_delete", "email_send", "email_reply"]) {
      expect(floorFor(mail, write)).toBe("risky");
    }
  });

  it("parses the tools map and drops values that are not a floor", () => {
    const config = parseMcpConfig({
      servers: { b: { command: "x", tools: { navigate: "safe", click: "risky", bogus: "maybe" } } },
    });
    expect(config.servers.b!.tools).toEqual({ navigate: "safe", click: "risky" });
  });
});

describe("reloading when the set of servers changes", () => {
  it("brings a server up, takes its tools back when it goes, and leaves the rest alone", async () => {
    const fake = fakeServer();
    const config: McpConfig = { servers: { a: { command: "x", risk: "safe" }, b: { command: "y", risk: "safe" } } };
    const registry = new ToolRegistry();
    const module = createMcpModule({
      workspaceRoot: "/tmp/kos-mcp-test",
      secrets: new SecretsRegistry(),
      config: () => config,
      transportFor: () => fake.transport(),
      report: () => undefined,
    });
    await module.activate(toolRegistryContext(registry));
    expect(Object.keys(module.status()).sort()).toEqual(["a", "b"]);
    expect(registry.has("mcp.a.add")).toBe(true);
    expect(registry.has("mcp.b.add")).toBe(true);

    delete config.servers.b;
    config.servers.c = { command: "z" };
    const after = await module.reload();
    expect(Object.keys(after).sort()).toEqual(["a", "c"]);
    expect(registry.has("mcp.b.add")).toBe(false);
    expect(registry.has("mcp.c.add")).toBe(true);
    // c took the default floor; a kept what it had.
    expect(registry.classify("mcp.c.add", {}).tier).toBe("risky");
    expect(registry.classify("mcp.a.add", {}).tier).toBe("safe");
    await module.deactivate!();
    expect(registry.has("mcp.a.add")).toBe(false);
  });
});

describe("tools from a server", () => {
  it("registers each tool and calls straight through", async () => {
    const h = harness({ servers: { fake: { command: "unused" } } });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const names = h.registry.defs().map((d) => d.name).sort();
    expect(names).toEqual(["mcp.fake.add", "mcp.fake.explode", "mcp.fake.picture"]);

    const result = await h.registry.execute("mcp.fake.add", { a: 2, b: 3 });
    expect(result.content).toBe("5");
    expect(h.fake.seen).toEqual([{ a: 2, b: 3 }]);
    await h.close();
  });

  it("turns a server's error flag into a tool error", async () => {
    const h = harness({ servers: { fake: { command: "unused" } } });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const result = await h.registry.execute("mcp.fake.explode", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
    await h.close();
  });

  it("is risky unless the owner says otherwise", async () => {
    const h = harness({
      servers: { fake: { command: "unused" }, trusted: { command: "unused", risk: "safe" } },
    });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(h.registry.classify("mcp.fake.add", {}).tier).toBe("risky");
    expect(h.registry.classify("mcp.trusted.add", {}).tier).toBe("safe");
    await h.close();
  });

  it("floors individual tools through the whole registration path", async () => {
    const h = harness({
      servers: { fake: { command: "unused", risk: "risky", tools: { add: "safe", "explod*": "safe" } } },
    });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(h.registry.classify("mcp.fake.add", {}).tier).toBe("safe");
    expect(h.registry.classify("mcp.fake.explode", {}).tier).toBe("safe");
    expect(h.registry.classify("mcp.fake.picture", {}).tier).toBe("risky");
    await h.close();
  });

  it("skips a server that is switched off", async () => {
    const h = harness({ servers: { fake: { command: "unused", enabled: false } } });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(h.registry.defs()).toEqual([]);
    await h.close();
  });

  it("reports a server it cannot reach and carries on", async () => {
    const h = harness({
      servers: { broken: { command: "unused" }, fake: { command: "unused" } },
    });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(h.reports.some((r) => r.startsWith("broken:"))).toBe(true);
    expect(h.registry.defs().map((d) => d.name)).toContain("mcp.fake.add");
    await h.close();
  });
});
