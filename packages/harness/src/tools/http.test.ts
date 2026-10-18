import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createHttpModule, type FetchImpl } from "./http.js";

describe("http.fetch module", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-http-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function load(opts: Parameters<typeof createHttpModule>[0], secrets = new SecretsRegistry()): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets });
    await new ModuleLoader(ctx).load([createHttpModule(opts)]);
    return registry;
  }

  it("fetches an allowlisted host and caps the body", async () => {
    const calls: { url: string; headers: unknown }[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      return new Response("x".repeat(50), { status: 200 });
    };
    const registry = await load({
      allowedHosts: ["api.example.com"],
      maxBytes: 10,
      fetchImpl,
    });
    const res = await registry.execute("http.fetch", {
      url: "https://api.example.com/data",
    });
    const out = JSON.parse(res.content);
    expect(out.status).toBe(200);
    expect(out.body).toHaveLength(10);
    expect(out.truncated).toBe(true);
    expect(calls[0]?.url).toBe("https://api.example.com/data");
  });

  it("asks about a host off the list rather than refusing it, and runs it once the owner says so", async () => {
    // A refusal left a watcher that needed one feed flailing in the browser,
    // where browser.visit would have opened the same site unasked.
    const reached: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      reached.push(String(url));
      return new Response("ok");
    };
    const registry = await load({ allowedHosts: ["api.example.com"], fetchImpl });
    expect(registry.classify("http.fetch", { url: "https://new.test/x" }).tier).toBe("risky");
    expect(registry.classify("http.fetch", { url: "not a url" }).tier).toBe("risky");
    // execute is what runs after the owner's yes: the handler does not refuse.
    const res = await registry.execute("http.fetch", { url: "https://new.test/x" });
    expect(res.isError).toBe(false);
    expect(reached).toEqual(["https://new.test/x"]);
    expect((await registry.execute("http.fetch", { url: "not a url" })).content).toMatch(/not a url/);
  });

  it("injects secrets into headers before the request", async () => {
    let seenAuth: string | undefined;
    const fetchImpl: FetchImpl = async (_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.authorization;
      return new Response("ok", { status: 200 });
    };
    const secrets = new SecretsRegistry({ openai: "sk-real" });
    const registry = await load(
      { allowedHosts: ["api.example.com"], fetchImpl },
      secrets,
    );
    await registry.execute("http.fetch", {
      url: "https://api.example.com",
      headers: { authorization: "Bearer {{secret:openai}}" },
    });
    expect(seenAuth).toBe("Bearer sk-real");
  });

  it("asks before a write, whatever the host", async () => {
    const registry = await load({ allowedHosts: ["api.example.com"], fetchImpl: async () => new Response("") });
    expect(
      registry.classify("http.fetch", {
        url: "https://api.example.com",
        method: "POST",
      }).tier,
    ).toBe("risky");
  });
});

/**
 * The allow-list is the permission. Every fetch used to queue for approval,
 * including to a host the owner had put on the list themselves, so the same
 * question was answered twice: once in settings and again on every call.
 */
describe("what a fetch asks about", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-http-tier-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function tiers(): Promise<(input: Record<string, unknown>) => string> {
    const registry = new ToolRegistry();
    const loader = new ModuleLoader(
      toolRegistryContext(registry, {
        workspace: ws,
        db: ws.db,
        secrets: new SecretsRegistry(),
      } as never),
    );
    await loader.load([
      createHttpModule({
        allowedHosts: ["example.com"],
        fetchImpl: async () => new Response(""),
      }),
    ]);
    return (input) => registry.classify("http.fetch", input).tier;
  }

  it("does not ask again about reading an allowed host", async () => {
    const tier = await tiers();
    expect(tier({ url: "https://example.com/feed" })).toBe("safe");
    expect(tier({ url: "https://example.com/feed", method: "get" })).toBe("safe");
    expect(tier({ url: "https://example.com/feed", method: "HEAD" })).toBe("safe");
  });

  it("still asks before writing to one", async () => {
    // Reading a page the owner allowed is what the list is for. Posting to it
    // is a different act, and one that can carry data out of the workspace.
    const tier = await tiers();
    expect(tier({ url: "https://example.com/x", method: "POST" })).toBe("risky");
    expect(tier({ url: "https://example.com/x", method: "delete" })).toBe("risky");
  });

  it("asks about reading a host that is not on the list", async () => {
    const tier = await tiers();
    expect(tier({ url: "https://other.example/feed" })).toBe("risky");
    expect(tier({ url: "https://EXAMPLE.com/feed" })).toBe("safe");
  });
});

/**
 * A host added in Settings should work on the next message.
 *
 * The list was read once at boot, so adding one at noon did nothing until the
 * daemon was restarted, which is not something an owner should have to know.
 */
describe("adding a host without a restart", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-http-live-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the list at call time", async () => {
    let hosts: string[] = [];
    const reached: string[] = [];
    const registry = new ToolRegistry();
    const loader = new ModuleLoader(
      toolRegistryContext(registry, {
        workspace: ws,
        db: ws.db,
        secrets: new SecretsRegistry(),
      } as never),
    );
    await loader.load([
      createHttpModule({
        allowedHosts: () => hosts,
        fetchImpl: async (url) => {
          reached.push(String(url));
          return new Response("ok");
        },
      }),
    ]);

    const tier = () => registry.classify("http.fetch", { url: "https://late.example.com/x" }).tier;

    // Nothing is listed yet, so the read would ask.
    expect(tier()).toBe("risky");

    // The owner adds it. No restart: the next read runs unasked.
    hosts = ["late.example.com"];
    expect(tier()).toBe("safe");
    expect((await registry.execute("http.fetch", { url: "https://late.example.com/x" })).isError).toBeFalsy();
    expect(reached).toHaveLength(1);
  });
});
