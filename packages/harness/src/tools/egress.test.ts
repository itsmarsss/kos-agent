import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { blockedAddress, guardedLookup, refusedUrl } from "./egress.js";
import { createHttpModule, type FetchImpl } from "./http.js";

describe("where http.fetch may not go", () => {
  it("knows this machine and its networks by address", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::5", "::ffff:127.0.0.1", "[::1]"]) {
      expect(blockedAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(blockedAddress(a), a).toBe(false);
  });

  it("refuses a local url, a non-web one and KOS's own host before resolving anything", () => {
    expect(refusedUrl("http://127.0.0.1:4317/api/approve")).toMatch(/this machine/);
    expect(refusedUrl("http://localhost:4317/")).toMatch(/this machine/);
    expect(refusedUrl("http://kos.local/")).toMatch(/this machine/);
    expect(refusedUrl("http://[::1]:4317/")).toMatch(/this machine/);
    expect(refusedUrl("http://2130706433/")).toMatch(/this machine/);
    expect(refusedUrl("file:///etc/passwd")).toMatch(/only http and https/);
    expect(refusedUrl("https://kos.example.com/api/approve", ["kos.example.com"])).toMatch(/KOS itself/);
    expect(refusedUrl("https://example.com/feed")).toBeUndefined();
  });

  it("refuses a name that resolves to this machine at the moment of connecting", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((done) => guardedLookup("localhost", { all: true }, (e) => done(e)));
    expect(err?.message).toMatch(/resolves to .*this machine/);
  });
});

describe("http.fetch and KOS's own API", () => {
  let root: string;
  let ws: Workspace;
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-egress-"));
    ws = Workspace.open(root);
    hits = 0;
    server = createServer((_req, res) => {
      hits++;
      res.end("approved");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise((done) => server.close(done));
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function fetchTool(fetchImpl?: FetchImpl): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await new ModuleLoader(toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() })).load([createHttpModule({ allowedHosts: [], ...(fetchImpl ? { fetchImpl } : {}) })]);
    return registry;
  }

  it("never reaches loopback, by address or by name", async () => {
    const registry = await fetchTool();
    for (const url of [`http://127.0.0.1:${port}/api/approve`, `http://localhost:${port}/api/approve`]) {
      const res = await registry.execute("http.fetch", { url, method: "POST", body: "{}" });
      expect(res.isError, url).toBe(true);
      expect(res.content).toMatch(/never reaches/);
    }
    expect(hits).toBe(0);
  });

  it("follows no redirect onto this machine", async () => {
    const seen: string[] = [];
    const registry = await fetchTool(async (url) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${port}/api/approve` } });
    });
    const res = await registry.execute("http.fetch", { url: "https://example.com/r" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/this machine/);
    expect(seen).toEqual(["https://example.com/r"]);
    expect(hits).toBe(0);
  });
});
