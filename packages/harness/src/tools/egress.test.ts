import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { blockedAddress, guardedLookup, lanAllows, lookupFor, parseLanAllow, reachesKos, refusedUrl } from "./egress.js";
import { createHttpModule, type FetchImpl } from "./http.js";

describe("where http.fetch may not go", () => {
  it("knows this machine and its networks by address", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::5", "::ffff:127.0.0.1", "[::1]"]) {
      expect(blockedAddress(a), a).toBe(true);
    }
    // IPv6 forms that carry an IPv4 address inside, and the old site-local range.
    for (const a of ["::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fec0::1"]) expect(blockedAddress(a), a).toBe(true);
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
    expect(refusedUrl("http://localhost.:4317/")).toMatch(/this machine/);
    expect(refusedUrl("https://kos.example.com./x", ["kos.example.com"])).toMatch(/KOS itself/);
  });

  it("reaches only the places the owner listed on their network, never KOS's ports, loopback port by port", async () => {
    const allow = parseLanAllow("192.168.1.0/24:8123, nas.local:5000, loopback:8080, 10.0.0.9:4317, junk", [4317, 4318]);
    expect(lanAllows(allow, "192.168.1.40", 8123)).toBe(true);
    expect(lanAllows(allow, "192.168.1.40", 8124)).toBe(false);
    expect(lanAllows(allow, "192.168.2.40", 8123)).toBe(false);
    expect(lanAllows(allow, "127.0.0.1", 8080)).toBe(true);
    expect(lanAllows(allow, "127.0.0.1", 8123)).toBe(false);
    expect(lanAllows(allow, "10.0.0.9", 4317)).toBe(false);
    expect(lanAllows(allow, "192.168.5.5", 5000, "nas.local")).toBe(true);
    expect(refusedUrl("http://192.168.1.40:8123/api", [], allow)).toBeUndefined();
    expect(refusedUrl("http://nas.local:5000/", [], allow)).toBeUndefined();
    expect(refusedUrl("http://nas.local:5001/", [], allow)).toMatch(/this machine/);
    expect(refusedUrl("http://127.0.0.1:4317/", [], parseLanAllow("loopback:4317", [4317]))).toMatch(/KOS itself/);
    // Empty by default: nothing local.
    expect(refusedUrl("http://192.168.1.40:8123/", [], parseLanAllow(undefined))).toMatch(/local network/);
    const lookedUp = await new Promise<NodeJS.ErrnoException | null>((done) => lookupFor(8080, allow)("localhost", { all: true }, (e) => done(e)));
    expect(lookedUp).toBeNull();
    const refused = await new Promise<NodeJS.ErrnoException | null>((done) => lookupFor(8081, allow)("localhost", { all: true }, (e) => done(e)));
    expect(refused?.message).toMatch(/this machine/);
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
    // Another origin is never followed: said, and a fetch there would be refused as any other.
    expect(res.content).toMatch(/Nothing was fetched there/);
    expect(seen).toEqual(["https://example.com/r"]);
    expect((await registry.execute("http.fetch", { url: JSON.parse(res.content).redirect })).content).toMatch(/never reaches/);
    expect(hits).toBe(0);
  });
});

describe("KOS's own page in a browser", () => {
  it("is any local host at one of KOS's ports, and nothing else", () => {
    expect(reachesKos("http://127.0.0.1:4317/#/inbox", [4317, 4318])).toBe(true);
    expect(reachesKos("localhost:4318", [4317, 4318])).toBe(true);
    expect(reachesKos("http://192.168.1.5:4317", [4317])).toBe(true);
    expect(reachesKos("http://127.0.0.1:5173", [4317])).toBe(false);
    expect(reachesKos("https://example.com:4317", [4317])).toBe(false);
  });
});
