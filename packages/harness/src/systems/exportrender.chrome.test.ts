import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNet, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CdpClient, ChromeHost, findChrome, type CdpSocket } from "@kos/browser";
import { WebSocket } from "ws";

import { SealedTab } from "./exportrender.js";

/**
 * Each of a sealed tab's locks, proven alone, in a Chrome with none of the
 * check Chrome's own (no resolver or proxy rules), against a listener that
 * counts every TCP connection: a control with the locks off connects, and
 * each lock on its own lets nothing through. Skipped without Chrome.
 */

const chrome = findChrome(undefined);

const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createNet();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });

describe.skipIf(!chrome)("a sealed tab's locks, each alone", () => {
  let host: ChromeHost;
  let cdp: CdpClient;
  let profile: string;
  let listener: Server;
  let port: number;
  const connections: number[] = [];

  beforeAll(async () => {
    listener = createServer((_req, res) => res.end("ok"));
    listener.on("connection", () => void connections.push(Date.now()));
    listener.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise<void>((ok) => listener.listen(0, "127.0.0.1", ok));
    port = (listener.address() as AddressInfo).port;
    profile = mkdtempSync(join(tmpdir(), "kos-sealed-"));
    host = new ChromeHost({ port: await freePort(), profileDir: profile, launch: () => ({ windowSize: { width: 800, height: 600 } }) });
    cdp = new CdpClient((u) => new WebSocket(u) as unknown as CdpSocket);
    await cdp.dial(await host.ensure(), () => undefined);
  }, 30_000);

  afterAll(async () => {
    cdp?.close();
    host?.stop();
    await host?.waitExit().catch(() => undefined);
    // Chrome's helpers can still be writing the profile a moment after it exits: a stray folder in tmp is no failure of the test.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left for the OS to sweep */
    }
    listener?.close();
  });

  /** Connections a page opening a WebSocket to the listener makes in a tab with these locks. */
  async function opened(options: { scripts: boolean; offline: boolean }): Promise<number> {
    connections.length = 0;
    const tab = await SealedTab.open(cdp, { ...options, track: () => undefined });
    try {
      const page = `<!doctype html><title>t</title><script>new WebSocket("ws://127.0.0.1:${port}/ws")</script>`;
      const loaded = tab.loaded(3000);
      await tab.navigate(page);
      await loaded;
      await new Promise((r) => setTimeout(r, 800));
      return connections.length;
    } finally {
      await tab.close();
    }
  }

  it("connects with both off: the control, so the listener would see a leak", async () => {
    expect(await opened({ scripts: true, offline: false })).toBeGreaterThan(0);
  }, 20_000);

  it("connects nowhere offline, scripts running", async () => {
    expect(await opened({ scripts: true, offline: true })).toBe(0);
  }, 20_000);

  it("connects nowhere with no script, online", async () => {
    expect(await opened({ scripts: false, offline: false })).toBe(0);
  }, 20_000);
});
