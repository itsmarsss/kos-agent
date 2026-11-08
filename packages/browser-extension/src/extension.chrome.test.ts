import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KOS_SEED, drawingOf, lookOf, outline, smoothPath } from "@kos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { deviceProof, hostProof } from "./protocol.js";

/**
 * The extension in a real Chrome, against a KOS played here: paired, both
 * keys proved, a session the owner allows in the extension's own window, a
 * tab opened in KOS's window, commands passed on or refused, the overlay on
 * the page, and the owner's own click taking the tab over. A second KOS,
 * the same server by another name, is paired beside it and told this Chrome
 * is busy; a site the owner hides is closed to KOS. Run on the built
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

/** A JPEG's size, from its frame header. */
function jpegSize(base64: string): { width: number; height: number } {
  const b = Buffer.from(base64, "base64");
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) return { width: 0, height: 0 };
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
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
  /** Each paired device's key and line, by the device id this KOS gave it. */
  const keys = new Map<string, KeyObject>();
  const lines = new Map<string, WebSocket>();
  let deviceKey: KeyObject | undefined;
  let device: WebSocket | undefined;
  let popup = "";
  const unpaired = new Set<string>();
  const forgotten = new Set<string>();
  const events: { name: string; data: Record<string, unknown> }[] = [];
  const replies = new Map<number, (r: Record<string, unknown>) => void>();
  let nextCall = 1;

  /** A call to the extension, as KOS would make it; one with no answer fails, rather than hanging the test. */
  const call = (method: string, params: Record<string, unknown>, on: WebSocket = device!): Promise<Record<string, unknown>> => {
    const id = nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15_000);
      replies.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      on.send(JSON.stringify({ t: "call", id, method, params }));
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
          // One code per pairing this server plays: the first KOS, the second it is by another name, and two for pairing again.
          const codes: Record<string, string> = { "TEST-CODE": "dev_test", "TEST-TWO": "dev_two", "TEST-THREE": "dev_three", "TEST-AGAIN": "dev_again" };
          const id = codes[pair.code];
          // A KOS that already holds this key, as the real one answers it.
          if (pair.code === "TEST-TAKEN") return void res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "this device is already paired" }));
          if (!id || pair.platform !== "chrome") return void res.writeHead(403).end("{}");
          keys.set(id, rawKey(Buffer.from(pair.publicKey, "base64")));
          if (id === "dev_test") deviceKey = keys.get(id);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ device: id, hostKey: hostRaw.toString("base64"), protocol: 1 }));
        });
        return;
      }
      // A page made of frames, as SmartBook is: the overlay must leave every one of them when the session ends.
      if (req.url === "/framed") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Framed</title><iframe src='/inner' style='width:400px;height:200px'></iframe>");
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Shop</title><button id='buy' style='margin:80px;padding:20px'>Buy</button>");
    });
    sockets = new WebSocketServer({ server, path: "/api/devices/socket" });
    sockets.on("connection", (ws) => {
      const challenge = randomBytes(32).toString("base64");
      ws.send(JSON.stringify({ t: "challenge", protocol: 1, nonce: challenge }));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (m["t"] === "hello") {
          const id = String(m["device"]);
          // A device this KOS has forgotten, turned away as the real one does, its reason in the close.
          if (forgotten.has(id)) return ws.close(4003, "unknown device: KOS has no device by this id; pair again");
          const key = keys.get(id);
          const ok = key && verify(null, Buffer.from(deviceProof(challenge, id)), key, Buffer.from(String(m["signature"]), "base64"));
          if (!ok) return ws.close(4003, "not a paired device");
          ws.send(JSON.stringify({ t: "welcome", name: "Test Chrome", signature: sign(null, Buffer.from(hostProof(String(m["nonce"]), id)), host.privateKey).toString("base64") }));
          lines.set(id, ws);
          if (id === "dev_test") device = ws;
        } else if (m["t"] === "ping") ws.send(JSON.stringify({ t: "pong" }));
        else if (m["t"] === "reply") replies.get(Number(m["id"]))?.(m);
        else if (m["t"] === "event") events.push({ name: String(m["name"]), data: m["data"] as Record<string, unknown> });
        else if (m["t"] === "unpair") for (const [id, line] of lines) if (line === ws) unpaired.add(id);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    profile = mkdtempSync(join(tmpdir(), "kos-extension-"));
    const port = 9800 + Math.floor(Math.random() * 100);
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging", "--no-first-run", "about:blank"], { stdio: "ignore" });
    let version: { webSocketDebuggerUrl: string } | undefined;
    // A CI machine can take a while to bring Chrome up; ten seconds once was not enough.
    for (let i = 0; i < 300 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => undefined);
      if (!version) await new Promise((r) => setTimeout(r, 100));
    }
    devtools = await Devtools.open(version!.webSocketDebuggerUrl);
    const { id } = (await devtools.send("Extensions.loadUnpacked", { path: DIST })) as { id: string };
    // Paired from the popup's own message, as its Pair button sends it.
    await devtools.send("Target.createTarget", { url: `chrome-extension://${id}/popup.html` });
    popup = await devtools.attach((u) => u.endsWith("/popup.html"));
    await devtools.loaded(popup);
    // A page opened the moment Chrome says the extension is in can come up before the extension is ready, without its APIs: reloaded until it has them.
    for (let i = 0; i < 50 && !(await devtools.evaluate(popup, "!!globalThis.chrome?.runtime?.id")); i++) {
      await devtools.send("Page.reload", {}, popup).catch(() => undefined);
      await until(() => false, 200);
      await devtools.loaded(popup);
    }
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

  it("draws KOS by the face it sends, and keeps it", async () => {
    const face = drawingOf(lookOf(KOS_SEED, { shape: "mochi", colour: "#8b5cf6" }));
    device!.send(JSON.stringify({ t: "face", face }));
    const kept = async (): Promise<unknown> => ((await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "state" })`)) as { value: { kos: { face?: unknown }[] } }).value.kos[0]?.face;
    for (let i = 0; i < 50 && JSON.stringify(await kept()) !== JSON.stringify(face); i++) await until(() => false, 100);
    expect(await kept()).toEqual(face);
    // The popup draws it at its next look, in the colour and outline sent.
    const body = "document.querySelector('.head .blob path[data-part=\"body\"]')";
    for (let i = 0; i < 40 && (await devtools.evaluate(popup, `${body}?.getAttribute('fill')`)) !== face.fill; i++) await until(() => false, 100);
    expect(await devtools.evaluate(popup, `${body}?.getAttribute('fill')`)).toBe(face.fill);
    const stored = (await devtools.evaluate(popup, `chrome.storage.local.get("pairings").then((r) => r.pairings[0].face)`)) as unknown;
    expect(stored).toEqual(face);
    // The toolbar wears it too: drawn without a word in the log, the body in its colour, the eyes in its ink, clear around.
    const log = (await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "log" })`)) as { value: string };
    expect(log.value).not.toMatch(/icon was not drawn/);
    const icon = (await devtools.evaluate(
      popup,
      `import(chrome.runtime.getURL("icon.js")).then(({ iconPixels }) => {
        const px = iconPixels({ fill: "#8b5cf6", ink: "#141d29", body: ${JSON.stringify(smoothPath(outline(face.shape)))}, eyes: [{ x: 40, y: 48 }, { x: 60, y: 48 }] }, 32);
        const at = (x, y) => Array.from(px.data.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
        return { body: at(16, 26), eye: at(Math.round((40 - 4) * 32 / 92), Math.round((48 - 4) * 32 / 92)), corner: at(0, 0) };
      })`,
    )) as { body: number[]; eye: number[]; corner: number[] };
    expect(icon.body).toEqual([0x8b, 0x5c, 0xf6, 255]);
    expect(icon.eye).toEqual([0x14, 0x1d, 0x29, 255]);
    expect(icon.corner[3]).toBe(0);
  }, 20_000);

  it("asks the owner before a session, in a window of its own, and refuses a call outside one", async () => {
    expect((await call("tabs.list", { session: "s1" }))["error"]).toMatchObject({ code: "no_session" });
    const begun = call("session.begin", { session: "s1", task: "buy the thing", requester: "Shopping", minutes: 15 });
    const consent = await devtools.attach((u) => u.includes("/consent.html"));
    await devtools.loaded(consent);
    // Allow is wired only once the window has the ask from the worker; its length choices appear in the same moment.
    for (let i = 0; i < 100 && !(await devtools.evaluate(consent, "document.querySelectorAll('#minutes button').length > 0")); i++) await until(() => false, 100);
    expect(await devtools.evaluate(consent, "document.getElementById('task').textContent")).toBe("buy the thing");
    await devtools.evaluate(consent, "document.getElementById('allow').click()");
    const answer = await begun;
    expect(answer).toMatchObject({ ok: true, result: { granted: true } });
    expect((await call("session.begin", { session: "s2", task: "again", requester: "x", minutes: 5 }))["error"]).toMatchObject({ code: "busy" });
  }, 30_000);

  it("pairs a second KOS beside the first, which is told this Chrome is busy and cannot act in the other's session", async () => {
    const other = base.replace("127.0.0.1", "localhost");
    const link = `kos-device://pair?url=${encodeURIComponent(other)}&code=test-two`;
    const paired = (await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "Test Chrome" })`)) as { ok: boolean; value: { kos: { id: string }[] } };
    expect(paired.value.kos.map((k) => k.id)).toEqual(["dev_test", "dev_two"]);
    await until(() => lines.has("dev_two"));
    const two = lines.get("dev_two")!;
    expect((await call("session.begin", { session: "w1", task: "mine", requester: "Work", minutes: 5 }, two))["error"]).toMatchObject({ code: "busy", message: "another KOS is using this Chrome" });
    expect((await call("tabs.list", { session: "s1" }, two))["error"]).toMatchObject({ code: "no_session" });
    const state = (await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "unpair", id: "dev_two" })`)) as { value: { kos: { id: string }[] } };
    expect(state.value.kos.map((k) => k.id)).toEqual(["dev_test"]);
    await until(() => unpaired.has("dev_two"));
    expect(unpaired.has("dev_two")).toBe(true);
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
    // A picture asked for smaller comes back that size on its longer side, in one call, taken without drawing the page again (which flashed the owner's tab).
    const metrics = (await cdp("Page.getLayoutMetrics"))["result"] as { cssVisualViewport: { clientWidth: number; clientHeight: number } };
    const { clientWidth: w, clientHeight: h } = metrics.cssVisualViewport;
    const edge = Math.round(Math.max(w, h) / 2);
    const shot = (await cdp("Page.captureScreenshot", { format: "jpeg", quality: 60, maxEdge: edge }))["result"] as { data: string };
    const size = jpegSize(shot.data);
    expect(Math.max(size.width, size.height)).toBe(edge);
    expect(size.width / size.height).toBeCloseTo(w / h, 1);
    // Asked again before the first is in, it is the same picture.
    const [a, b] = await Promise.all([cdp("Page.captureScreenshot", { format: "jpeg", quality: 60, maxEdge: edge }), cdp("Page.captureScreenshot", { format: "jpeg", quality: 60, maxEdge: edge })]);
    expect(jpegSize((a["result"] as { data: string }).data)).toEqual(size);
    expect(jpegSize((b["result"] as { data: string }).data)).toEqual(size);
    // Several commands in one round trip, each checked as one alone would be: in order up to the first refused, or side by side.
    const calls = [
      { method: "Runtime.evaluate", params: { expression: "1 + 1", returnByValue: true } },
      { method: "Storage.getCookies", params: {} },
      { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } },
    ];
    const inOrder = (await call("cdp.batch", { session: "s1", tab, calls }))["result"] as { results: Record<string, unknown>[] };
    expect(inOrder.results).toEqual([{ result: { result: { type: "number", value: 2, description: "2" } } }, { error: expect.objectContaining({ code: "method" }) }]);
    const sideBySide = (await call("cdp.batch", { session: "s1", tab, calls, parallel: true }))["result"] as { results: Record<string, unknown>[] };
    expect(sideBySide.results).toHaveLength(3);
    expect(sideBySide.results[2]).toMatchObject({ result: { result: { value: "Shop" } } });
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

  it("closes a site the owner hid: no look, no way there, and no name in the tab list", async () => {
    const tab = ((await call("tabs.list", { session: "s1" }))["result"] as { tabs: { id: string }[] }).tabs[0]!.id;
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "hide", site: "127.0.0.1" })`)).toMatchObject({ ok: true });
    expect((await call("cdp.send", { session: "s1", tab, method: "Runtime.evaluate", params: { expression: "document.title" } }))["error"]).toMatchObject({ code: "hidden_site" });
    expect((await call("tabs.open", { session: "s1", url: `${base}/again` }))["error"]).toMatchObject({ code: "hidden_site" });
    expect(await call("tabs.list", { session: "s1" })).toMatchObject({ ok: true, result: { tabs: [{ id: tab, url: "", title: "Hidden from KOS", hidden: true }] } });
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "unhide", site: "127.0.0.1" })`)).toMatchObject({ ok: true });
  });

  it("ends when KOS says, and lets go of the tab, leaving no overlay in any frame", async () => {
    const framed = ((await call("tabs.open", { session: "s1", url: `${base}/framed` }))["result"] as { tab: string }).tab;
    await call("cdp.send", { session: "s1", tab: framed, method: "Page.enable", params: {} });
    const page = await devtools.attach((u) => u.endsWith("/framed"));
    for (let i = 0; i < 50 && !(await devtools.evaluate(page, "!!document.querySelector('kos-overlay')")); i++) await until(() => false, 100);
    expect(await devtools.evaluate(page, "!!document.querySelector('kos-overlay')")).toBe(true);
    expect(await call("session.end", { session: "s1" })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && (await devtools.evaluate(page, "!!document.querySelector('kos-overlay')")); i++) await until(() => false, 100);
    expect(await devtools.evaluate(page, "!!document.querySelector('kos-overlay')")).toBe(false);
    await until(() => events.some((e) => e.name === "session.ended"));
    expect(events.find((e) => e.name === "session.ended")?.data).toMatchObject({ session: "s1", reason: "host" });
    expect((await call("tabs.list", { session: "s1" }))["error"]).toMatchObject({ code: "no_session" });
  });

  it("carries a side panel's chat, asks for a session there, and works in the tab beside it", async () => {
    const id = new URL(await devtools.evaluate(popup, "location.href") as string).host;
    await devtools.send("Target.createTarget", { url: `chrome-extension://${id}/panel.html` });
    const panel = await devtools.attach((u) => u.endsWith("/panel.html"));
    await devtools.loaded(panel);
    await until(() => events.some((e) => e.name === "chat.open"));
    const text = (): Promise<string> => devtools.evaluate(panel, "document.body.innerText") as Promise<string>;
    // An empty chat offers a start; pressing one says it to KOS.
    for (let i = 0; i < 100 && !(await devtools.evaluate(panel, "!!document.querySelector('.suggest button')")); i++) await until(() => false, 100);
    await devtools.evaluate(panel, "document.querySelector('.suggest button').click()");
    await until(() => events.some((e) => e.name === "chat.send"));
    expect(events.find((e) => e.name === "chat.send")?.data).toMatchObject({ text: "Summarize this page", beside: { kind: expect.stringMatching(/page|other/) } });
    expect(await call("chat.show", { conversation: "chrome:owner", title: "Chrome", messages: [{ role: "you", text: "Summarize this page" }, { role: "kos", text: "It is a **shop**." }] })).toMatchObject({ ok: true });
    await until(() => false, 300);
    expect(await text()).toContain("It is a shop.");
    // The tab beside the panel: KOS reads it only for the panel's chat, and only once the owner allows reading pages.
    await devtools.send("Target.createTarget", { url: `${base}/beside` });
    await until(() => false, 500);
    expect((await call("page.read", { conversation: "project:other" }))["error"]).toMatchObject({ code: "no_panel" });
    // Not allowed yet: asked in the panel, and "Not now" is a no that KOS hears in words.
    const read = call("page.read", { conversation: "chrome:owner" });
    const card = "document.querySelector('.ask-card--read')";
    for (let i = 0; i < 100 && !(await devtools.evaluate(panel, `!!${card}`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `${card}.textContent`)).toContain("127.0.0.1");
    await devtools.evaluate(panel, `${card}.querySelector('.btn').click()`);
    expect((await read)["error"]).toMatchObject({ code: "permission", message: "the owner did not let KOS read pages in this Chrome" });
    // The panel's chat asks for a session: asked in the panel, no window of its own, and granted for the tab beside it.
    const begun = call("session.begin", { session: "p1", task: "add the mug", requester: "Chrome", conversation: "chrome:owner", minutes: 15 });
    for (let i = 0; i < 100 && !(await devtools.evaluate(panel, "!!document.querySelector('.ask-card--consent')")); i++) await until(() => false, 100);
    expect(await text()).toContain("add the mug");
    await devtools.evaluate(panel, "document.querySelector('.ask-card--consent .btn--primary').click()");
    expect(await begun).toMatchObject({ ok: true, result: { granted: true } });
    const listed = (await call("tabs.list", { session: "p1" }))["result"] as { tabs: { url: string; focus?: boolean; handed?: boolean }[] };
    expect(listed.tabs).toEqual([expect.objectContaining({ url: `${base}/beside`, focus: true, handed: true })]);
    expect(await call("session.end", { session: "p1" })).toMatchObject({ ok: true });
    // Words after the steps, the turn still going: the foot still says it works, until the turn ends.
    const foot = "document.querySelector('.working')";
    expect(await call("chat.status", { conversation: "chrome:owner", said: "Summarize this page", story: "› Read the page\nChecking the prices now." })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && !(await devtools.evaluate(panel, `!!${foot}?.querySelector('.live-dots')`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)).toMatch(/^Working\s*\d+s$/);
    expect(await text()).toContain("Checking the prices now.");
    // Held on an approval, the turn is the owner's to move: it says so, with no dots and no clock.
    expect(await call("chat.ask", { approval: { id: "a1", tool: "shell.run" } })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && (await devtools.evaluate(panel, `!!${foot}?.querySelector('.live-dots')`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)).toBe("Waiting on you");
    expect(await call("chat.settled", { approval: "a1" })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && !(await devtools.evaluate(panel, `!!${foot}?.querySelector('.live-dots')`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)).toMatch(/^Working\s*\d+s$/);
    // Words queued behind it, taken once it is done: the next turn counts from its own start.
    const elapsed = async (): Promise<number> => Number(/(\d+)s$/.exec(String(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)))?.[1] ?? -1);
    for (let i = 0; i < 50 && (await elapsed()) < 2; i++) await until(() => false, 100);
    expect(await elapsed()).toBeGreaterThanOrEqual(2);
    expect(await call("chat.status", { conversation: "chrome:owner", taken: true, said: "And the shipping?" })).toMatchObject({ ok: true });
    await until(() => false, 200);
    expect(await elapsed()).toBeLessThan(2);
    expect(await call("chat.status", { conversation: "chrome:owner" })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && (await devtools.evaluate(panel, `!!${foot}`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `!!${foot}`)).toBe(false);
    // The queued words answered, so none is left on its way for the next test.
    expect(await call("chat.show", { conversation: "chrome:owner", title: "Chrome", messages: [{ role: "you", text: "Summarize this page" }, { role: "kos", text: "It is a **shop**." }, { role: "you", text: "And the shipping?" }, { role: "kos", text: "Free." }] })).toMatchObject({ ok: true });
  }, 40_000);

  it("never waits forever: words KOS does not take come back, and a KOS that never shows the chat is said to", async () => {
    const id = new URL((await devtools.evaluate(popup, "location.href")) as string).host;
    const first = await devtools.attach((u) => u.endsWith("/panel.html"));
    // A second panel, on a KOS that will never show it the chat.
    await devtools.send("Target.createTarget", { url: `chrome-extension://${id}/panel.html?again` });
    const second = await devtools.attach((u) => u.endsWith("/panel.html?again"));
    await devtools.loaded(second);
    await devtools.evaluate(
      first,
      `(() => { const ta = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'are you there'); ta.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => document.querySelector('.send').click(), 50); })()`,
    );
    await until(() => events.some((e) => e.name === "chat.send" && e.data["text"] === "are you there"));
    await until(() => false, 13_000);
    expect(await devtools.evaluate(first, "document.querySelector('.panel-error')?.innerText ?? ''")).toContain("KOS did not take that");
    expect(await devtools.evaluate(first, "document.querySelector('textarea').value")).toBe("are you there");
    expect(await devtools.evaluate(second, "document.body.innerText")).toContain("This KOS cannot talk here yet");
  }, 40_000);

  it("tells KOS when the owner unpairs it here, so KOS forgets it too", async () => {
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "unpair", id: "dev_test" })`)).toMatchObject({ ok: true, value: { kos: [] } });
    await until(() => unpaired.has("dev_test"));
    expect(unpaired.has("dev_test")).toBe(true);
  });

  it("says why KOS turned it away, in KOS's words, and pairs again from the card with a key of its own", async () => {
    type Line = { id: string; url: string; link: string; detail?: string };
    const kos = async (): Promise<Line[]> => ((await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "state" })`)) as { value: { kos: Line[] } }).value.kos;
    const link = `kos-device://pair?url=${encodeURIComponent(base)}&code=test-three`;
    await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "Test Chrome" })`);
    await until(() => lines.has("dev_three"));
    // KOS forgets it while it is away; at its next hello it is told why.
    forgotten.add("dev_three");
    lines.get("dev_three")!.close(1001, "KOS is stopping");
    const reason = "Unknown device: KOS has no device by this id; pair again.";
    for (let i = 0; i < 100 && (await kos())[0]?.link !== "unpaired"; i++) await until(() => false, 100);
    expect((await kos())[0]).toMatchObject({ id: "dev_three", link: "unpaired", detail: reason });

    await devtools.send("Page.reload", {}, popup);
    await devtools.loaded(popup);
    const shown = async (js: string): Promise<unknown> => {
      for (let i = 0; i < 50 && !(await devtools.evaluate(popup, `!!(${js})`)); i++) await until(() => false, 100);
      return devtools.evaluate(popup, js);
    };
    expect(await shown("document.querySelector('.kos-reason p')?.textContent")).toBe(reason);
    expect(await devtools.evaluate(popup, "document.querySelector('.kos-reason p').title")).toBe(reason);
    expect(await devtools.evaluate(popup, "document.querySelector('.head .pill').textContent")).toBe("Not paired");
    await devtools.evaluate(popup, "[...document.querySelectorAll('.kos-reason button')].find((b) => b.textContent === 'Pair again').click()");
    expect(await shown("document.querySelector('.pair-form--again input.mono')?.value")).toBe(base);
    await devtools.evaluate(
      popup,
      `(() => { const code = document.querySelectorAll('.pair-form--again input.mono')[1]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(code, 'test-again'); code.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => document.querySelector('.pair-form--again button[type=submit]').click(), 50); })()`,
    );
    await until(() => lines.has("dev_again"));
    expect(lines.has("dev_again")).toBe(true);
    // A new key, not the one the forgotten pairing had: a KOS that still held the old one would refuse it as already paired.
    const raw = (id: string): string => keys.get(id)!.export({ format: "der", type: "spki" }).toString("base64");
    expect(raw("dev_again")).not.toBe(raw("dev_three"));
    for (let i = 0; i < 50 && (await kos())[0]?.link !== "online"; i++) await until(() => false, 100);
    expect((await kos()).map((k) => [k.id, k.link])).toEqual([["dev_again", "online"]]);
  }, 40_000);

  /** The extension's worker stopped, as Chrome stops an idle one or a restart does: the next message starts it afresh from storage. */
  const restartWorker = async (): Promise<void> => {
    const { targetInfos } = (await devtools.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const worker = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/worker.js"));
    if (worker) await devtools.send("Target.closeTarget", { targetId: worker.targetId });
    await until(() => false, 300);
  };
  type Shown = { id: string; link: string; detail?: string };
  const shownKos = async (): Promise<Shown[]> => ((await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "state" })`)) as { value: { kos: Shown[] } }).value.kos;
  const settled = async (want: (k: Shown[]) => boolean): Promise<Shown[]> => {
    for (let i = 0; i < 100 && !want(await shownKos().catch(() => [])); i++) await until(() => false, 100);
    return shownKos();
  };
  const storedKeys = (): Promise<unknown> =>
    devtools.evaluate(popup, `new Promise((res) => { const r = indexedDB.open("kos", 1); r.onsuccess = () => { const q = r.result.transaction("keys").objectStore("keys").getAllKeys(); q.onsuccess = () => res(q.result); }; })`);

  it("keeps the key for an id a KOS gives again, and says a KOS that refuses the pairing in its words", async () => {
    await devtools.send("Page.reload", {}, popup);
    await devtools.loaded(popup);
    const again = `kos-device://pair?url=${encodeURIComponent(base)}&code=test-again`;
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(again)}, name: "Test Chrome" })`)).toMatchObject({ ok: true });
    expect(await storedKeys()).toContain("device:dev_again");
    await restartWorker();
    expect(await settled((k) => k[0]?.link === "online")).toMatchObject([{ id: "dev_again", link: "online" }]);
    const taken = `kos-device://pair?url=${encodeURIComponent(base)}&code=test-taken`;
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(taken)}, name: "Test Chrome" })`)).toEqual({ ok: false, error: "this device is already paired" });
    expect((await shownKos()).map((k) => k.id)).toEqual(["dev_again"]);
  }, 30_000);

  it("moves an older version's one pairing and the key it shared, and says when that key is gone rather than making another", async () => {
    // As an older version left it: one pairing under "paired", and one key under "device" for every KOS.
    const raw = (await devtools.evaluate(
      popup,
      `crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]).then(async (pair) => {
        await new Promise((res) => { const r = indexedDB.open("kos", 1); r.onsuccess = () => { const t = r.result.transaction("keys", "readwrite"); t.objectStore("keys").clear(); t.objectStore("keys").put(pair, "device"); t.oncomplete = res; }; });
        return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))));
      })`,
    )) as string;
    keys.set("dev_legacy", rawKey(Buffer.from(raw, "base64")));
    const paired = { url: base, device: "dev_legacy", hostKey: hostRaw.toString("base64"), name: "Test Chrome" };
    await devtools.evaluate(popup, `chrome.storage.local.remove("pairings").then(() => chrome.storage.local.set({ paired: ${JSON.stringify(paired)} }))`);
    await restartWorker();
    expect(await settled((k) => k[0]?.link === "online")).toMatchObject([{ id: "dev_legacy", link: "online" }]);
    expect(await devtools.evaluate(popup, `chrome.storage.local.get(["pairings", "paired"]).then((r) => [r.pairings.map((p) => p.device), r.paired ?? null])`)).toEqual([["dev_legacy"], null]);
    expect(lines.has("dev_legacy")).toBe(true);

    // The key gone, as when the extension's storage is cleared under it: no new key in its place, which KOS would refuse as a bad signature.
    await devtools.evaluate(popup, `new Promise((res) => { const r = indexedDB.open("kos", 1); r.onsuccess = () => { const t = r.result.transaction("keys", "readwrite"); t.objectStore("keys").clear(); t.oncomplete = res; }; })`);
    await restartWorker();
    expect(await settled((k) => k[0]?.link === "unpaired")).toEqual([expect.objectContaining({ id: "dev_legacy", link: "unpaired", detail: "This Chrome no longer has the key it paired with. Pair again." })]);
    expect(await storedKeys()).toEqual([]);
  }, 30_000);
});
