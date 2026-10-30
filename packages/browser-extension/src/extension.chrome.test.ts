import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { deviceProof, hostProof } from "./protocol.js";

/**
 * The extension in a real Chrome, against a KOS played here: paired, both
 * keys proved, a session the owner allows in the extension's own window, a
 * tab opened in KOS's window, commands passed on or refused, the overlay on
 * the page, and the owner's own click taking the tab over. Run on the built
 * extension (pnpm -C packages/browser-extension build); skipped without a
 * Chrome or a build.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const BUILT = existsSync(join(DIST, "worker.js"));

/** Ed25519 public keys as the protocol sends them, 32 raw bytes, made into Node's kind. */
function rawKey(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

/** A DevTools connection to the test's Chrome, for playing the owner and finding the extension's windows. */
class Devtools {
  private id = 0;
  private readonly waiting = new Map<number, (m: Record<string, unknown>) => void>();
  private constructor(private readonly ws: globalThis.WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (typeof m["id"] === "number") this.waiting.get(m["id"])?.(m);
    };
  }
  static async open(url: string): Promise<Devtools> {
    const ws = new WebSocket(url);
    await new Promise((r) => (ws.onopen = r));
    return new Devtools(ws);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m["error"] ? reject(new Error(JSON.stringify(m["error"]))) : resolve((m["result"] as Record<string, unknown>) ?? {})));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r["exceptionDetails"]) throw new Error(JSON.stringify(r["exceptionDetails"]));
    return (r["result"] as { value?: unknown }).value;
  }
  /** Until the page has loaded, so its scripts and the extension's APIs are there. */
  async loaded(sessionId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if ((await this.evaluate(sessionId, "document.readyState").catch(() => "")) === "complete") return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async attach(match: (url: string) => boolean): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const { targetInfos } = (await this.send("Target.getTargets")) as { targetInfos: { targetId: string; url: string; type: string }[] };
      const found = targetInfos.find((t) => t.type === "page" && match(t.url));
      if (found) return String((await this.send("Target.attachToTarget", { targetId: found.targetId, flatten: true }))["sessionId"]);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no such page");
  }
  close(): void {
    this.ws.close();
  }
}

describe.skipIf(!CHROME || !BUILT)("the extension in a real Chrome", () => {
  const host = generateKeyPairSync("ed25519");
  const hostRaw = host.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  let server: Server;
  let sockets: WebSocketServer;
  let base = "";
  let chrome: ChildProcess;
  let profile = "";
  let devtools: Devtools;
  let deviceKey: KeyObject | undefined;
  let device: WebSocket | undefined;
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const replies = new Map<number, (r: Record<string, unknown>) => void>();
  let nextCall = 1;

  /** A call to the extension, as KOS would make it. */
  const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextCall++;
    return new Promise((resolve) => {
      replies.set(id, resolve);
      device!.send(JSON.stringify({ t: "call", id, method, params }));
    });
  };
  const until = async (check: () => boolean, ms = 10_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      // KOS's pairing, as the real one answers it (readable from any origin, no preflight); the page KOS's tab opens.
      if (req.url === "/api/devices/pair" && req.method === "POST") {
        res.setHeader("access-control-allow-origin", "*");
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const pair = JSON.parse(body) as { code: string; publicKey: string; platform: string };
          if (pair.code !== "TEST-CODE" || pair.platform !== "chrome") return void res.writeHead(403).end("{}");
          deviceKey = rawKey(Buffer.from(pair.publicKey, "base64"));
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ device: "dev_test", hostKey: hostRaw.toString("base64"), protocol: 1 }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Shop</title><button id='buy' style='margin:80px;padding:20px'>Buy</button>");
    });
    sockets = new WebSocketServer({ server, path: "/api/devices/socket" });
    sockets.on("connection", (ws) => {
      const challenge = randomBytes(32).toString("base64");
      ws.send(JSON.stringify({ t: "challenge", protocol: 1, nonce: challenge }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (m["t"] === "hello") {
          const ok = deviceKey && verify(null, Buffer.from(deviceProof(challenge, String(m["device"]))), deviceKey, Buffer.from(String(m["signature"]), "base64"));
          if (!ok) return ws.close(4003, "not a paired device");
          ws.send(JSON.stringify({ t: "welcome", name: "Test Chrome", signature: sign(null, Buffer.from(hostProof(String(m["nonce"]), "dev_test")), host.privateKey).toString("base64") }));
          device = ws;
        } else if (m["t"] === "ping") ws.send(JSON.stringify({ t: "pong" }));
        else if (m["t"] === "reply") replies.get(Number(m["id"]))?.(m);
        else if (m["t"] === "event") events.push({ name: String(m["name"]), data: m["data"] as Record<string, unknown> });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    profile = mkdtempSync(join(tmpdir(), "kos-extension-"));
    const port = 9800 + Math.floor(Math.random() * 100);
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging", "--no-first-run", "about:blank"], { stdio: "ignore" });
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 100 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => undefined);
      if (!version) await new Promise((r) => setTimeout(r, 100));
    }
    devtools = await Devtools.open(version!.webSocketDebuggerUrl);
    const { id } = (await devtools.send("Extensions.loadUnpacked", { path: DIST })) as { id: string };
    // Paired from the popup's own message, as its Pair button sends it.
    await devtools.send("Target.createTarget", { url: `chrome-extension://${id}/popup.html` });
    const popup = await devtools.attach((u) => u.endsWith("/popup.html"));
    await devtools.loaded(popup);
    const link = `kos-device://pair?url=${encodeURIComponent(base)}&code=test-code`;
    const paired = (await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "Test Chrome" })`)) as { ok: boolean; error?: string };
    expect(paired).toMatchObject({ ok: true });
    await until(() => device !== undefined);
  }, 60_000);

  afterAll(async () => {
    devtools?.close();
    chrome?.kill();
    await new Promise((r) => chrome?.once("exit", r));
    sockets?.close();
    server?.closeAllConnections();
    server?.close();
    // Chrome's helpers can still be writing the profile as it goes; a temp folder left behind is no failure.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      /* left for the system to clear */
    }
  });

  it("pairs, proves both keys, and keeps the connection with pings", () => {
    expect(deviceKey).toBeDefined();
    expect(device).toBeDefined();
  });

  it("asks the owner before a session, in a window of its own, and refuses a call outside one", async () => {
    expect((await call("tabs.list", { session: "s1" }))["error"]).toMatchObject({ code: "no_session" });
    const begun = call("session.begin", { session: "s1", task: "buy the thing", requester: "Shopping", minutes: 15 });
    const consent = await devtools.attach((u) => u.includes("/consent.html"));
    await devtools.loaded(consent);
    await until(() => false, 300);
    expect(await devtools.evaluate(consent, "document.getElementById('task').textContent")).toBe("buy the thing");
    await devtools.evaluate(consent, "document.getElementById('allow').click()");
    const answer = await begun;
    expect(answer).toMatchObject({ ok: true, result: { granted: true } });
    expect((await call("session.begin", { session: "s2", task: "again", requester: "x", minutes: 5 }))["error"]).toMatchObject({ code: "busy" });
  }, 30_000);

  it("opens a tab in KOS's window, passes on the commands its hands use, and refuses the rest", async () => {
    const opened = await call("tabs.open", { session: "s1", url: `${base}/shop` });
    const tab = (opened["result"] as { tab: string }).tab;
    expect(tab).toMatch(/^\d+$/);
    const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => call("cdp.send", { session: "s1", tab, method, params });
    await cdp("Page.enable");
    await until(() => false, 500);
    const title = await cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true });
    expect(title["result"]).toMatchObject({ result: { value: "Shop" } });
    expect((await cdp("Storage.getCookies"))["error"]).toMatchObject({ code: "method" });
    expect((await cdp("Page.navigate", { url: "file:///etc/passwd" }))["error"]).toMatchObject({ code: "url" });
    expect((await call("cdp.send", { session: "s1", tab: "999999", method: "Runtime.evaluate", params: { expression: "1" } }))["error"]).toMatchObject({ code: "tab" });
    // The overlay is on the page, and out of its accessibility tree.
    await until(() => false, 300);
    const overlay = await cdp("Runtime.evaluate", { expression: "(() => { const o = document.querySelector('kos-overlay'); return o ? o.getAttribute('aria-hidden') : 'none'; })()", returnByValue: true });
    expect(overlay["result"]).toMatchObject({ result: { value: "true" } });
    expect(await call("tabs.list", { session: "s1" })).toMatchObject({ ok: true, result: { tabs: [{ id: tab, title: "Shop" }] } });
  }, 30_000);

  it("knows its own click from the owner's, and the owner's takes the tab over", async () => {
    const tab = ((await call("tabs.list", { session: "s1" }))["result"] as { tabs: { id: string }[] }).tabs[0]!.id;
    const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => call("cdp.send", { session: "s1", tab, method, params });
    // KOS's own click: the page sees it, and nothing pauses.
    for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: 120, y: 110, button: "left", clickCount: 1 });
    await until(() => false, 500);
    expect(events.some((e) => e.name === "session.paused")).toBe(false);
    // The owner's: straight to the page, not through KOS.
    const page = await devtools.attach((u) => u.endsWith("/shop"));
    for (const type of ["mousePressed", "mouseReleased"]) await devtools.send("Input.dispatchMouseEvent", { type, x: 300, y: 300, button: "left", clickCount: 1 }, page);
    await until(() => events.some((e) => e.name === "session.paused"));
    expect(events.find((e) => e.name === "session.paused")?.data).toMatchObject({ session: "s1", reason: "owner" });
    expect((await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }))["error"]).toMatchObject({ code: "paused" });
  }, 30_000);

  it("ends when KOS says, and lets go of the tab", async () => {
    expect(await call("session.end", { session: "s1" })).toMatchObject({ ok: true });
    await until(() => events.some((e) => e.name === "session.ended"));
    expect(events.find((e) => e.name === "session.ended")?.data).toMatchObject({ session: "s1", reason: "host" });
    expect((await call("tabs.list", { session: "s1" }))["error"]).toMatchObject({ code: "no_session" });
  });
});
