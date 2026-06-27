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

  it("rejects a non-allowlisted host", async () => {
    const fetchImpl: FetchImpl = async () => new Response("ok");
    const registry = await load({ allowedHosts: ["api.example.com"], fetchImpl });
    const res = await registry.execute("http.fetch", { url: "https://evil.test/x" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not allowlisted/);
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

  it("is risky tier", async () => {
    const registry = await load({ allowedHosts: ["api.example.com"], fetchImpl: async () => new Response("") });
    expect(registry.classify("http.fetch", { url: "https://api.example.com" }).tier).toBe(
      "risky",
    );
  });
});
