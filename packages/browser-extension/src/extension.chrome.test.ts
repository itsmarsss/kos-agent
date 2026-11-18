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
import { GRACE_MS } from "./session.js";

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

/** A page's own report of each press it hears. */
const PRESSES = "addEventListener('pointerdown', () => navigator.sendBeacon('/pressed'), true)";

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
  /** Events heard, in order, each with the session it came on. */
  readonly heard: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  private constructor(private readonly ws: globalThis.WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (typeof m["id"] === "number") this.waiting.get(m["id"])?.(m);
      else if (typeof m["method"] === "string") this.heard.push(m as { method: string; params: Record<string, unknown>; sessionId?: string });
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
  /** Each hello the extension sent, in order. */
  const hellos: Record<string, unknown>[] = [];
  const replies = new Map<number, (r: Record<string, unknown>) => void>();
  let nextCall = 1;
  let pressed = 0;

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
      // A link that goes on to another site, one the owner may hide.
      // Every press a page here heard, told by the page itself: one on a hidden site counts too.
      if (req.url === "/pressed") return void (pressed++, res.writeHead(204).end());
      if (req.url === "/elsewhere") return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Elsewhere</title><script>${PRESSES}</script><p>Elsewhere`);
      if (req.url === "/away") return void res.writeHead(302, { location: `${base.replace("127.0.0.1", "localhost")}/secret` }).end();
      if (req.url === "/link") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Link</title><a href='/away' style='display:block;margin:80px;padding:20px'>Away</a>");
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
          hellos.push(m);
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
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging", "--no-first-run", "about:blank"], { stdio: "ignore", detached: true });
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
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((r) => chrome.once("exit", r));
      // Its own process group, helpers and all, so nothing is still writing the profile when it is deleted.
      try {
        process.kill(-chrome.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      await exited;
    }
    sockets?.close();
    server?.closeAllConnections();
    server?.close();
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Whether the overlay's button for an act is drawn on the page: found through its closed shadow root, and given a box. */
  const boxOf = async (page: string, attr: string, value: string): Promise<{ left: number; right: number; top: number; bottom: number } | undefined> => {
    type Node = { nodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] };
    const { root } = (await devtools.send("DOM.getDocument", { depth: -1, pierce: true }, page)) as { root: Node };
    const find = (n: Node): Node | undefined => {
      const a = n.attributes ?? [];
      if (a.includes(attr) && a[a.indexOf(attr) + 1] === value) return n;
      for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) {
        const hit = find(c);
        if (hit) return hit;
      }
      return undefined;
    };
    const node = find(root);
    if (!node) return undefined;
    const model = (await devtools.send("DOM.getBoxModel", { nodeId: node.nodeId }, page).catch(() => undefined)) as { model?: { border: number[] } } | undefined;
    const q = model?.model?.border;
    return q ? { left: q[0]!, top: q[1]!, right: q[2]!, bottom: q[5]! } : undefined;
  };
  /** Whether the overlay's button for an act is drawn on the page. */
  const drawn = async (page: string, act: string): Promise<boolean> => (await boxOf(page, "data-act", act)) !== undefined;

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
    // No world of the overlay's name for KOS, whose binding speaks for the owner, and none with more reach than the page.
    const frameId = ((await cdp("Page.getFrameTree"))["result"] as { frameTree: { frame: { id: string } } }).frameTree.frame.id;
    expect((await cdp("Page.createIsolatedWorld", { frameId, worldName: "kos" }))["error"]).toMatchObject({ code: "method" });
    expect((await cdp("Page.createIsolatedWorld", { frameId, worldName: "kos-hands", grantUniveralAccess: true }))["error"]).toMatchObject({ code: "method" });
    expect(await cdp("Page.createIsolatedWorld", { frameId, worldName: "kos-hands" })).toMatchObject({ ok: true, result: { executionContextId: expect.any(Number) } });
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

  it("lets no command reach the overlay's world, by any name for it or an object in it", async () => {
    const tab = ((await call("tabs.list", { session: "s1" }))["result"] as { tabs: { id: string }[] }).tabs[0]!.id;
    const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => call("cdp.send", { session: "s1", tab, method, params });
    // The tab's worlds, as this test's own debugger sees them: the overlay's is the one named as the extension names it.
    const page = await devtools.attach((u) => u.endsWith("/shop"));
    await devtools.send("Runtime.enable", {}, page);
    type Context = { id: number; uniqueId: string; name: string; auxData?: { frameId?: string; isDefault?: boolean } };
    const contexts = (): Context[] => devtools.heard.filter((m) => m.sessionId === page && m.method === "Runtime.executionContextCreated").map((m) => m.params["context"] as Context);
    await until(() => contexts().some((c) => c.name === "kos"));
    const overlay = contexts().find((c) => c.name === "kos")!;
    expect(overlay).toBeDefined();
    const refused = { error: expect.objectContaining({ code: "method", message: expect.stringMatching(/overlay/) }) };
    const handback = `function () { kosOverlay(JSON.stringify({ kind: "handback" })); return 1; }`;
    // A node resolved into the overlay's world, which a function called on it would run in, is not made.
    const body = ((await cdp("Runtime.evaluate", { expression: "document.body" }))["result"] as { result: { objectId: string } }).result.objectId;
    const node = ((await cdp("DOM.describeNode", { objectId: body }))["result"] as { node: { backendNodeId: number } }).node.backendNodeId;
    expect(await cdp("DOM.resolveNode", { backendNodeId: node, executionContextId: overlay.id })).toMatchObject(refused);
    // One resolved into the hands' world is made, its id naming that world, and a function runs on it.
    const frameId = ((await cdp("Page.getFrameTree"))["result"] as { frameTree: { frame: { id: string } } }).frameTree.frame.id;
    const hands = ((await cdp("Page.createIsolatedWorld", { frameId, worldName: "kos-hands" }))["result"] as { executionContextId: number }).executionContextId;
    const resolved = ((await cdp("DOM.resolveNode", { backendNodeId: node, executionContextId: hands }))["result"] as { object: { objectId: string } }).object.objectId;
    expect(resolved).toMatch(new RegExp(`^-?\\d+\\.${hands}\\.\\d+$`));
    expect(await cdp("Runtime.callFunctionOn", { objectId: resolved, functionDeclaration: "function () { return this.tagName; }", returnByValue: true })).toMatchObject({ ok: true, result: { result: { value: "BODY" } } });
    // An object of the overlay's world, by its id, is not reached: here one this test made there.
    const theirs = ((await devtools.send("Runtime.evaluate", { expression: "document.body", contextId: overlay.id }, page))["result"] as { objectId: string }).objectId;
    expect(theirs).toMatch(new RegExp(`^-?\\d+\\.${overlay.id}\\.\\d+$`));
    expect(await cdp("Runtime.callFunctionOn", { objectId: theirs, functionDeclaration: handback })).toMatchObject(refused);
    expect(await cdp("Runtime.getProperties", { objectId: theirs })).toMatchObject(refused);
    // Each name a command may give its world is read alone: a string in one does not let the overlay's id through in another.
    expect(await cdp("Runtime.callFunctionOn", { functionDeclaration: handback, contextId: "x", executionContextId: overlay.id })).toMatchObject({ error: expect.objectContaining({ code: "method" }) });
    expect(await cdp("Runtime.callFunctionOn", { functionDeclaration: handback, contextId: 1, executionContextId: overlay.id })).toMatchObject(refused);
    expect(await cdp("Runtime.evaluate", { expression: `(${handback})()`, uniqueContextId: overlay.uniqueId })).toMatchObject(refused);
    expect(await cdp("Runtime.callFunctionOn", { functionDeclaration: handback, uniqueContextId: overlay.uniqueId })).toMatchObject(refused);
    // Only worlds Chrome has said it made, the page's and the hands': one it has not, or one another made (here this test, as an extension would), is refused.
    const unknown = { error: expect.objectContaining({ code: "method", message: expect.stringMatching(/not one Chrome has said this tab holds/) }) };
    expect(await cdp("Runtime.evaluate", { expression: "1", contextId: 999_999 })).toMatchObject(unknown);
    expect(await cdp("Runtime.getProperties", { objectId: "1.999999.1" })).toMatchObject(unknown);
    const another = ((await devtools.send("Page.createIsolatedWorld", { frameId, worldName: "another" }, page)) as { executionContextId: number }).executionContextId;
    expect(await cdp("Runtime.evaluate", { expression: "1", contextId: another })).toMatchObject({ error: expect.objectContaining({ code: "method", message: expect.stringMatching(/neither the page's nor KOS's own/) }) });
    // The page's own world, by its id, and a hands' world used the moment it is made.
    const main = contexts().find((c) => c.auxData?.isDefault && c.auxData.frameId === frameId)!;
    expect(await cdp("Runtime.evaluate", { expression: "document.title", contextId: main.id, returnByValue: true })).toMatchObject({ ok: true, result: { result: { value: "Shop" } } });
    const fresh = ((await cdp("Page.createIsolatedWorld", { frameId, worldName: "kos-hands" }))["result"] as { executionContextId: number }).executionContextId;
    expect(await cdp("Runtime.evaluate", { expression: "document.title", contextId: fresh, returnByValue: true })).toMatchObject({ ok: true, result: { result: { value: "Shop" } } });
    await until(() => false, 300);
    expect(events.some((e) => e.name === "session.resumed" || e.name === "session.ended")).toBe(false);
    await devtools.send("Target.detachFromTarget", { sessionId: page });
  }, 30_000);

  /** KOS's cursor on a page, read through the overlay's closed shadow root: where its tip is, whether it ripples, shows and lets clicks through, and its tag. */
  type Cursor = { x: number; y: number; rippling: boolean; shown: boolean; through: boolean; tag: string; tagShown: boolean };
  const cursorOn = async (page: string): Promise<Cursor> => {
    type Node = { nodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] };
    const { root } = (await devtools.send("DOM.getDocument", { depth: -1, pierce: true }, page)) as { root: Node };
    const find = (n: Node): Node | undefined => {
      const a = n.attributes ?? [];
      if (/^cursor\b/.test(a[a.indexOf("class") + 1] ?? "") && a.includes("class")) return n;
      for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) {
        const hit = find(c);
        if (hit) return hit;
      }
      return undefined;
    };
    const node = find(root);
    if (!node) throw new Error("no cursor on the page");
    const { object } = (await devtools.send("DOM.resolveNode", { nodeId: node.nodeId }, page)) as { object: { objectId: string } };
    const read = `function () {
      const m = new DOMMatrix(getComputedStyle(this).transform);
      const style = getComputedStyle(this);
      return { x: m.e, y: m.f, rippling: this.getAnimations({ subtree: true }).some((a) => a.animationName === "ripple" && a.playState === "running"),
        shown: style.visibility === "visible" && Number(style.opacity) === 1, through: style.pointerEvents === "none", tag: this.querySelector(".tag").textContent,
        tagShown: getComputedStyle(this.querySelector(".tag")).visibility === "visible" };
    }`;
    const r = (await devtools.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: read, returnByValue: true }, page)) as { result: { value: Cursor } };
    return r.result.value;
  };
  /** The cursor once it has come to rest where expected, or as it is after a second. */
  const cursorSettled = async (page: string, want: (c: Cursor) => boolean): Promise<Cursor> => {
    let c = await cursorOn(page);
    for (let i = 0; i < 40 && !want(c); i++) {
      await until(() => false, 25);
      c = await cursorOn(page);
    }
    return c;
  };
  const near = (c: { x: number; y: number }, p: { x: number; y: number }): boolean => Math.abs(c.x - p.x) < 0.5 && Math.abs(c.y - p.y) < 0.5;

  it("shows KOS's cursor from the start, and glides it to each point KOS acts at before acting there", async () => {
    const tab = ((await call("tabs.list", { session: "s1" }))["result"] as { tabs: { id: string }[] }).tabs[0]!.id;
    const cdp = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const r = await call("cdp.send", { session: "s1", tab, method, params });
      if (r["error"]) throw new Error(JSON.stringify(r["error"]));
      return r["result"] as Record<string, unknown>;
    };
    const value = async <T,>(expression: string): Promise<T> => ((await cdp("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value: T } }).result.value;
    const nodeOf = async (selector: string): Promise<number> => {
      const { result } = (await cdp("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` })) as { result: { objectId: string } };
      return ((await cdp("DOM.describeNode", { objectId: result.objectId })) as { node: { backendNodeId: number } }).node.backendNodeId;
    };
    const middle = async (selector: string): Promise<{ x: number; y: number }> =>
      value(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    /** The cursor's tip on a point, to within a pixel's rounding. */
    const at = (p: { x: number; y: number }) => ({ x: expect.closeTo(p.x, 0), y: expect.closeTo(p.y, 0) });
    const page = await devtools.attach((u) => u.endsWith("/shop"));
    // On the page before KOS has pointed anywhere, in the middle, letting every click through to the page.
    const view = await value<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
    const first = await cursorOn(page);
    expect(first).toMatchObject({ ...at({ x: view.w / 2, y: view.h / 2 }), shown: true, through: true, tag: "KOS", tagShown: true });
    expect(await value("document.elementFromPoint(innerWidth / 2, innerHeight / 2).tagName")).not.toBe("KOS-OVERLAY");

    // A click as KOS's hands make one: the cursor glides there quickly, and is there when the press lands, which ripples.
    const buy = await middle("#buy");
    const started = Date.now();
    const clicked = (await call("cdp.batch", {
      session: "s1",
      tab,
      calls: ["mouseMoved", "mousePressed", "mouseReleased"].map((type) => ({ method: "Input.dispatchMouseEvent", params: { type, x: buy.x, y: buy.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 } })),
    }))["result"] as { results: unknown[] };
    const took = Date.now() - started;
    expect(clicked.results).toHaveLength(3);
    expect(took).toBeGreaterThanOrEqual(40);
    expect(took).toBeLessThan(350);
    expect(await cursorOn(page)).toMatchObject({ ...at(buy), shown: true });
    expect(await cursorSettled(page, (c) => c.rippling)).toMatchObject({ rippling: true });
    // KOS's hands one after another, never side by side.
    const side = await call("cdp.batch", { session: "s1", tab, parallel: true, calls: [{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 5, y: 5 } }] });
    expect(side["error"]).toMatchObject({ code: "bad_request" });
    // Clicked again where it is: nothing to glide, nothing waited on.
    const again = Date.now();
    await call("cdp.batch", { session: "s1", tab, calls: ["mouseMoved", "mousePressed", "mouseReleased"].map((type) => ({ method: "Input.dispatchMouseEvent", params: { type, x: buy.x, y: buy.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 } })) });
    expect(Date.now() - again).toBeLessThan(100);

    // A field focused to type in: the cursor goes to its middle, and its tag says KOS is typing.
    await value("(() => { document.body.insertAdjacentHTML('beforeend', `<input id='name' style='position:fixed;left:40px;top:300px;width:160px'><div style='height:3000px'></div><p id='far'>Far</p>`); return 1; })()");
    await cdp("DOM.focus", { backendNodeId: await nodeOf("#name") });
    const name = await middle("#name");
    expect(await cursorSettled(page, (c) => near(c, name))).toMatchObject(at(name));
    await cdp("Input.insertText", { text: "Ada" });
    expect((await cursorOn(page)).tag).toBe("KOS · typing");

    // Scrolled to: the cursor rests at the element's middle where the scroll brought it, a moment later.
    await cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: await nodeOf("#far") });
    expect(await value<number>("scrollY")).toBeGreaterThan(1000);
    const far = await middle("#far");
    expect(await cursorSettled(page, (c) => near(c, far))).toMatchObject(at(far));

    // A wheel turned where KOS points: the cursor there, and kept there as the page scrolls under it, as a pointer is.
    const before = await value<number>("scrollY");
    await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: 220, y: 160, deltaX: 0, deltaY: -400 });
    for (let i = 0; i < 30 && (await value<number>("scrollY")) === before; i++) await until(() => false, 50);
    expect(await value<number>("scrollY")).toBeLessThan(before);
    expect(await cursorSettled(page, (c) => near(c, { x: 220, y: 160 }))).toMatchObject({ x: 220, y: 160 });

    // A drag follows the held button closely; its press ripples where it began.
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: 200, button: "left", buttons: 1, clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 340, y: 230, button: "left", buttons: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: 340, y: 230, button: "left", clickCount: 1 });
    expect(await cursorSettled(page, (c) => near(c, { x: 340, y: 230 }))).toMatchObject({ x: 340, y: 230 });

    // KOS's own picture of the page: the arrow alone while it is taken, its halo and tag out of the way, and whole again after.
    const host = "document.querySelector('kos-overlay')";
    await devtools.evaluate(page, `(window.kosMarks = [], new MutationObserver(() => kosMarks.push(${host}.dataset.capture)).observe(${host}, { attributeFilter: ["data-capture"] }), 1)`);
    await cdp("Page.captureScreenshot", { format: "jpeg", quality: 60, maxEdge: 400 });
    await until(() => false, 100);
    expect(await devtools.evaluate(page, "kosMarks")).toEqual(["1", ""]);
    expect((await cursorOn(page)).tagShown).toBe(true);

    // A new page of the tab: the cursor where it was, not back in the middle; and between steps it stays.
    await cdp("Page.reload");
    await devtools.loaded(page);
    for (let i = 0; i < 50 && (await cursorOn(page).catch(() => ({ x: 0 }))).x !== 340; i++) await until(() => false, 100);
    await until(() => false, 600);
    expect(await cursorOn(page)).toMatchObject({ x: 340, y: 230, shown: true });

    // Zoomed in, the point KOS's hands find for an element (the middle of its quads) is where the page puts the pointer and where the cursor goes.
    const ratio = await value<number>("devicePixelRatio");
    await devtools.evaluate(popup, `chrome.tabs.setZoom(${tab}, 1.5)`);
    for (let i = 0; i < 50 && (await value<number>("devicePixelRatio")) === ratio; i++) await until(() => false, 50);
    // The page laid out again at its new size.
    await until(() => false, 300);
    const q = ((await cdp("DOM.getContentQuads", { backendNodeId: await nodeOf("#buy") })) as { quads: number[][] }).quads[0]!;
    const aimed = { x: (q[0]! + q[4]!) / 2, y: (q[1]! + q[5]!) / 2 };
    await value("(window.kosSeen = [], addEventListener('pointermove', (e) => kosSeen.push({ x: e.clientX, y: e.clientY }), true), 1)");
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: aimed.x, y: aimed.y });
    expect(await value("kosSeen.at(-1)")).toMatchObject(at(aimed));
    const drawn = await middle("#buy");
    expect(await cursorSettled(page, (c) => near(c, drawn))).toMatchObject(at(drawn));
    await devtools.evaluate(popup, `chrome.tabs.setZoom(${tab}, 0)`);
    await devtools.send("Target.detachFromTarget", { sessionId: page });
  }, 30_000);

  it("knows its own click from the owner's, and the owner's takes the tab over", async () => {
    const tab = ((await call("tabs.list", { session: "s1" }))["result"] as { tabs: { id: string }[] }).tabs[0]!.id;
    const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => call("cdp.send", { session: "s1", tab, method, params });
    // KOS's own click: the page sees it, and nothing pauses.
    for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: 120, y: 110, button: "left", clickCount: 1 });
    await until(() => false, 500);
    expect(events.some((e) => e.name === "session.paused")).toBe(false);
    // The small bar chosen in Settings: KOS's face and Stop alone on the page, and the owner's hand still takes over.
    const page = await devtools.attach((u) => u.endsWith("/shop"));
    const overlay = (key: string): Promise<unknown> => devtools.evaluate(page, `document.querySelector('kos-overlay')?.dataset.${key}`);
    // The full bar folded to KOS's face first: a fold the small bar must not keep.
    const face = (await boxOf(page, "class", "face"))!;
    for (const type of ["mousePressed", "mouseReleased"]) await devtools.send("Input.dispatchMouseEvent", { type, x: (face.left + face.right) / 2, y: (face.top + face.bottom) / 2, button: "left", clickCount: 1 }, page);
    for (let i = 0; i < 50 && (await overlay("folded")) !== "1"; i++) await until(() => false, 100);
    expect(await overlay("folded")).toBe("1");
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "settings", patch: { fullBar: false } })`)).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && (await overlay("bar")) !== "chip"; i++) await until(() => false, 100);
    expect(await overlay("bar")).toBe("chip");
    expect(await overlay("folded")).toBe("");
    // Drawn on the page: KOS's face and Stop, one press away, side by side and level; not Take over or the words.
    const small = (await boxOf(page, "class", "face"))!;
    const stop = (await boxOf(page, "data-act", "stop"))!;
    expect(stop.left - small.right).toBeGreaterThanOrEqual(4);
    expect(Math.abs((stop.top + stop.bottom) / 2 - (small.top + small.bottom) / 2)).toBeLessThan(1.5);
    expect(Math.abs(stop.bottom - stop.top - (small.bottom - small.top))).toBeLessThan(1);
    expect(await drawn(page, "take")).toBe(false);
    // The owner's, once the moment after they allowed it has passed: straight to the page, not through KOS.
    await until(() => false, GRACE_MS);
    for (const type of ["mousePressed", "mouseReleased"]) await devtools.send("Input.dispatchMouseEvent", { type, x: 300, y: 300, button: "left", clickCount: 1 }, page);
    await until(() => events.some((e) => e.name === "session.paused"));
    expect(events.find((e) => e.name === "session.paused")?.data).toMatchObject({ session: "s1", reason: "owner" });
    expect((await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }))["error"]).toMatchObject({ code: "paused" });
    // Nothing that could change the page while the owner has it: going places, focus, scroll, a dialog's answer, script. Reads go on.
    const body = 1;
    for (const [method, params] of [
      ["Runtime.evaluate", { expression: "1" }],
      ["Runtime.callFunctionOn", { functionDeclaration: "() => 1", executionContextId: 1 }],
      ["DOM.focus", { backendNodeId: body }],
      ["DOM.scrollIntoViewIfNeeded", { backendNodeId: body }],
      ["Page.reload", {}],
      ["Page.navigate", { url: `${base}/shop` }],
      ["Page.handleJavaScriptDialog", { accept: true }],
    ] as const) expect((await cdp(method, params))["error"], method).toMatchObject({ code: "paused" });
    expect(await cdp("Page.getLayoutMetrics")).toMatchObject({ ok: true });
    expect(await cdp("Accessibility.getFullAXTree", { depth: 1 })).toMatchObject({ ok: true });
    // Paused, the small bar offers Hand back beside Stop; KOS's cursor is gone while the owner has the tab.
    for (let i = 0; i < 50 && (await overlay("paused")) !== "1"; i++) await until(() => false, 100);
    expect(await drawn(page, "handback")).toBe(true);
    expect(await drawn(page, "stop")).toBe(true);
    const kept = await cursorOn(page);
    expect(kept.shown).toBe(false);
    // Handed back, it is where it was.
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "handback" })`)).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && (await overlay("paused")) === "1"; i++) await until(() => false, 100);
    expect(await cursorOn(page)).toMatchObject({ x: kept.x, y: kept.y, shown: true });
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "settings", patch: { fullBar: true } })`)).toMatchObject({ ok: true });
  }, 30_000);

  it("sends no click of KOS's once the owner takes the tab while its cursor is on the way", async () => {
    const tab = ((await call("tabs.list", { session: "s1" }))["result"] as { tabs: { id: string }[] }).tabs[0]!.id;
    const page = await devtools.attach((u) => u.endsWith("/shop"));
    await devtools.evaluate(page, "(window.kosBought = 0, document.getElementById('buy').addEventListener('pointerdown', () => kosBought++), 1)");
    const buy = (await devtools.evaluate(page, "(() => { const r = document.getElementById('buy').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()")) as { x: number; y: number };
    // Past the moment after the last hand back; the cursor far from the button.
    await until(() => false, GRACE_MS);
    await call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 700, y: 500 } });
    await until(() => false, 500);
    const pressing = call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: buy.x, y: buy.y, button: "left", clickCount: 1 } });
    await until(() => false, 30);
    for (const type of ["mousePressed", "mouseReleased"]) await devtools.send("Input.dispatchMouseEvent", { type, x: 600, y: 60, button: "left", clickCount: 1 }, page);
    expect((await pressing)["error"]).toMatchObject({ code: "paused" });
    expect((await call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: buy.x, y: buy.y, button: "left", clickCount: 1 } }))["error"]).toMatchObject({ code: "paused" });
    expect(await devtools.evaluate(page, "kosBought")).toBe(0);

    // Something the page puts over everything in the top layer, where no z-index reaches: the bar is over it still, and answers the owner.
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "handback" })`)).toMatchObject({ ok: true });
    const overlay = (key: string): Promise<unknown> => devtools.evaluate(page, `document.querySelector('kos-overlay')?.dataset.${key}`);
    for (let i = 0; i < 50 && (await overlay("paused")) === "1"; i++) await until(() => false, 100);
    await devtools.evaluate(page, "(() => { const d = document.createElement('div'); d.id = 'cover'; d.popover = 'manual'; d.style.cssText = 'inset: 0; width: 100vw; height: 100vh; margin: 0'; d.textContent = 'Subscribe!'; document.body.append(d); d.showPopover(); return 1; })()");
    // Folded to KOS's face since the owner pressed it: a press on it opens the bar again, over what the page put there.
    expect(await overlay("folded")).toBe("1");
    const face = (await boxOf(page, "class", "face"))!;
    for (const type of ["mousePressed", "mouseReleased"]) await devtools.send("Input.dispatchMouseEvent", { type, x: (face.left + face.right) / 2, y: (face.top + face.bottom) / 2, button: "left", clickCount: 1 }, page);
    for (let i = 0; i < 50 && (await overlay("folded")) === "1"; i++) await until(() => false, 100);
    expect(await overlay("folded")).toBe("");
    expect(await drawn(page, "stop")).toBe(true);
    await devtools.evaluate(page, "(document.getElementById('cover').hidePopover(), 1)");

    // A page that tries to hide or recolour the overlay, by a rule or on the element itself: it is put back as it was.
    await devtools.evaluate(page, `(() => {
      document.head.insertAdjacentHTML("beforeend", "<style>kos-overlay { display: none !important; opacity: 0 !important; --accent: red !important; --bar: transparent !important; }</style>");
      const o = document.querySelector("kos-overlay");
      o.style.setProperty("display", "none", "important");
      o.removeAttribute("popover");
      o.dataset.paused = "1";
      return 1;
    })()`);
    await until(() => false, 150);
    expect(await devtools.evaluate(page, "(() => { const o = document.querySelector('kos-overlay'); return [getComputedStyle(o).display, getComputedStyle(o).opacity, o.matches(':popover-open'), o.dataset.paused]; })()")).toEqual(["block", "1", true, ""]);
    expect(await drawn(page, "stop")).toBe(true);

    // The site hidden while the cursor is on its way to a press: nothing is pressed, and KOS hears the site is hidden.
    await devtools.evaluate(page, "(window.kosBought = 0, 1)");
    await call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 790, y: 590 } });
    await until(() => false, 300);
    const hiding = call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: buy.x, y: buy.y, button: "left", clickCount: 1 } });
    await until(() => false, 15);
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "hide", site: "127.0.0.1" })`)).toMatchObject({ ok: true });
    expect((await hiding)["error"]).toMatchObject({ code: "hidden_site" });
    expect(await devtools.evaluate(page, "kosBought")).toBe(0);
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "unhide", site: "127.0.0.1" })`)).toMatchObject({ ok: true });
    for (const type of ["mouseReleased"]) await call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type, x: buy.x, y: buy.y, button: "left", clickCount: 1 } });

    // The page sent to a hidden site while the cursor is on its way to a press: nothing is pressed, and KOS hears the site is hidden.
    const other = base.replace("127.0.0.1", "localhost");
    await call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 790, y: 590 } });
    await until(() => false, 300);
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "hide", site: "localhost" })`)).toMatchObject({ ok: true });
    await devtools.evaluate(page, `(${PRESSES}, 1)`);
    const before = pressed;
    const going = call("cdp.send", { session: "s1", tab, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: buy.x, y: buy.y, button: "left", clickCount: 1 } });
    await until(() => false, 15);
    await devtools.evaluate(page, `(location.href = ${JSON.stringify(`${other}/elsewhere`)}, 1)`);
    expect((await going)["error"]).toMatchObject({ code: "hidden_site" });
    await until(() => false, 300);
    expect(pressed).toBe(before);
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "unhide", site: "localhost" })`)).toMatchObject({ ok: true });
    await devtools.send("Page.navigate", { url: `${base}/shop` }, page);
    await devtools.loaded(page);
    await devtools.send("Target.detachFromTarget", { sessionId: page });
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

  describe("a tab the owner handed, in sessions one after another", () => {
    let tab = "";
    let owners = "";
    const popupSays = (message: Record<string, unknown>): Promise<unknown> => devtools.evaluate(popup, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
    const batch = (session: string, calls: { method: string; params?: Record<string, unknown> }[]): Promise<Record<string, unknown>> => call("cdp.batch", { session, tab, calls });
    const slow = (ms: number): { method: string; params: Record<string, unknown> } => ({ method: "Runtime.evaluate", params: { expression: `new Promise((r) => setTimeout(() => r(1), ${ms}))`, awaitPromise: true, returnByValue: true } });
    const title = { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } };
    /** A session KOS may start without asking, as one whose owner left it to its own approvals. */
    const begin = async (id: string): Promise<void> => {
      expect(await call("session.begin", { session: id, task: "work in my tab", requester: "Test", minutes: 5 })).toMatchObject({ ok: true, result: { granted: true } });
    };
    /** Whether anything but this test has a debugger on the tab: the test's own let go of to ask, and taken up again. */
    const debugged = async (): Promise<boolean> => {
      await devtools.send("Target.detachFromTarget", { sessionId: owners });
      const { targetInfos } = (await devtools.send("Target.getTargets")) as { targetInfos: { url: string; attached: boolean }[] };
      owners = await devtools.attach((u) => u.endsWith("/mine"));
      return targetInfos.some((t) => t.url.endsWith("/mine") && t.attached);
    };
    const handBack = async (): Promise<void> => {
      await popupSays({ type: "hand", tab: Number(tab), give: true });
    };

    beforeAll(async () => {
      expect(await popupSays({ type: "askFirst", id: "dev_test", on: false })).toMatchObject({ ok: true });
      await devtools.send("Target.createTarget", { url: `${base}/mine` });
      owners = await devtools.attach((u) => u.endsWith("/mine"));
      await devtools.loaded(owners);
      tab = String(await devtools.evaluate(popup, `chrome.tabs.query({}).then((ts) => ts.find((t) => t.url.endsWith("/mine")).id)`));
      await handBack();
    }, 30_000);

    afterAll(async () => {
      await popupSays({ type: "hand", tab: Number(tab), give: false });
      await popupSays({ type: "unhide", site: "localhost" });
      await popupSays({ type: "askFirst", id: "dev_test", on: true });
      await devtools.evaluate(popup, `chrome.tabs.remove(${tab})`);
    });

    it("asks Chrome where a tab is once it has let go of it: a hidden site it went to meanwhile stays closed", async () => {
      await begin("h1");
      expect(await call("cdp.send", { session: "h1", tab, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } })).toMatchObject({ ok: true });
      expect(await call("session.end", { session: "h1" })).toMatchObject({ ok: true });
      // Between sessions, with no debugger on it to hear it, the owner goes to a site they hide.
      expect(await popupSays({ type: "hide", site: "localhost" })).toMatchObject({ ok: true });
      await devtools.send("Page.navigate", { url: `${base.replace("127.0.0.1", "localhost")}/secret` }, owners);
      await devtools.loaded(owners);
      await begin("h2");
      expect((await call("cdp.send", { session: "h2", tab, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }))["error"]).toMatchObject({ code: "hidden_site" });
      await devtools.send("Page.navigate", { url: `${base}/mine` }, owners);
      await devtools.loaded(owners);
      expect(await call("cdp.send", { session: "h2", tab, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } })).toMatchObject({ ok: true, result: { result: { value: "Shop" } } });
    }, 30_000);

    it("stops a batch whose page goes to a hidden site part way, giving nothing of where it went", async () => {
      try {
        const done = (await batch("h2", [{ method: "Page.navigate", params: { url: `${base}/away` } }, title]))["result"] as { results: Record<string, unknown>[] };
        expect(done.results).toEqual([{ error: expect.objectContaining({ code: "hidden_site" }) }]);
      } finally {
        await devtools.send("Page.navigate", { url: `${base}/mine` }, owners);
        await devtools.loaded(owners);
      }
    }, 30_000);

    it("gives KOS nothing of a page a click took to a hidden site, while a command ran or after", async () => {
      const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => call("cdp.send", { session: "h2", tab, method, params });
      try {
        await devtools.send("Page.navigate", { url: `${base}/link` }, owners);
        await devtools.loaded(owners);
        for (const type of ["mousePressed", "mouseReleased"]) expect(await cdp("Input.dispatchMouseEvent", { type, x: 120, y: 110, button: "left", clickCount: 1 })).toMatchObject({ ok: true });
        // A look begun as the click takes the page away, answered once the tab is on the hidden site: refused, not its answer.
        expect((await cdp("Runtime.evaluate", { expression: "new Promise((r) => setTimeout(() => r(document.title), 1500))", awaitPromise: true, returnByValue: true }))["error"]).toMatchObject({ code: "hidden_site" });
        expect((await cdp("Page.captureScreenshot", { format: "jpeg", quality: 60 }))["error"]).toMatchObject({ code: "hidden_site" });
        expect((await cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true }))["error"]).toMatchObject({ code: "hidden_site" });
      } finally {
        await devtools.send("Page.navigate", { url: `${base}/mine` }, owners);
        await devtools.loaded(owners);
      }
      // The tab's history names no hidden site, and goes back to none.
      const { entries } = (await cdp("Page.getNavigationHistory"))["result"] as { entries: { id: number; url: string; title: string }[] };
      expect(entries.some((e) => e.url.includes("localhost"))).toBe(false);
      const hidden = entries.find((e) => e.title === "Hidden from KOS");
      expect(hidden).toMatchObject({ url: "" });
      expect((await cdp("Page.navigateToHistoryEntry", { entryId: hidden!.id }))["error"]).toMatchObject({ code: "hidden_site" });
      expect(await cdp("Runtime.evaluate", { expression: "location.pathname", returnByValue: true })).toMatchObject({ ok: true, result: { result: { value: "/mine" } } });
    }, 30_000);

    it("tells KOS of a route the page changes to itself, in its main frame only", async () => {
      const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => call("cdp.send", { session: "h2", tab, method, params });
      const routes = (): unknown[] => events.filter((e) => e.name === "cdp.event" && e.data["method"] === "Page.navigatedWithinDocument").map((e) => (e.data["params"] as { url?: unknown }).url);
      const before = routes().length;
      // A frame's route first, then the page's: only the page's crosses.
      await cdp("Runtime.evaluate", { expression: "new Promise((r) => { const f = document.createElement('iframe'); f.src = '/inner'; f.onload = () => { f.contentWindow.history.pushState({}, '', '/inner/next'); r(1); }; document.body.append(f); })", awaitPromise: true });
      await cdp("Runtime.evaluate", { expression: "history.pushState({}, '', '/mine/next')" });
      await until(() => routes().length > before);
      await until(() => false, 300);
      expect(routes().slice(before)).toEqual([`${base}/mine/next`]);
      await devtools.send("Page.navigate", { url: `${base}/mine` }, owners);
      await devtools.loaded(owners);
    }, 30_000);

    it("refuses the rest of a batch once the owner takes the tab over part way", async () => {
      // Past the moment after the last hand back, when the owner's hand is not yet a takeover.
      await until(() => false, GRACE_MS);
      const running = batch("h2", [slow(600), { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 5, y: 5 } }]);
      await until(() => false, 200);
      for (const type of ["mousePressed", "mouseReleased"]) await devtools.send("Input.dispatchMouseEvent", { type, x: 300, y: 300, button: "left", clickCount: 1 }, owners);
      expect((await running)["error"]).toMatchObject({ code: "paused" });
      expect(await popupSays({ type: "handback" })).toMatchObject({ ok: true });
    }, 30_000);

    it("refuses the rest of a batch once the owner takes the tab back part way, and lets go of it", async () => {
      const running = batch("h2", [slow(600), title, title]);
      await until(() => false, 200);
      await popupSays({ type: "hand", tab: Number(tab), give: false });
      expect((await running)["error"]).toMatchObject({ code: "tab" });
      expect(await debugged()).toBe(false);
      await handBack();
      expect(await call("session.end", { session: "h2" })).toMatchObject({ ok: true });
    }, 30_000);

    it("refuses the rest of a batch once the session ends part way, and does not take the tab up again", async () => {
      await begin("h3");
      const running = batch("h3", [slow(600), title, title]);
      await until(() => false, 200);
      expect(await call("session.end", { session: "h3" })).toMatchObject({ ok: true });
      expect((await running)["error"]).toMatchObject({ code: "no_session" });
      await until(() => false, 300);
      expect(await debugged()).toBe(false);
    }, 30_000);

    it("keeps a session across a short drop of its KOS's line, and says so in the hello", async () => {
      await begin("k1");
      const before = hellos.length;
      device!.close();
      await until(() => hellos.length > before && device?.readyState === 1, 15_000);
      expect(hellos.at(-1)?.["session"]).toEqual({ id: "k1" });
      expect(await call("tabs.list", { session: "k1" })).toMatchObject({ ok: true });
      expect(await call("session.end", { session: "k1" })).toMatchObject({ ok: true });
    }, 30_000);

    it("tells KOS a session its stopped worker held is over, in the next worker's hello, and lets its tab go", async () => {
      await begin("r1");
      expect(await call("cdp.send", { session: "r1", tab, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } })).toMatchObject({ ok: true });
      expect(await debugged()).toBe(true);
      // Chrome stops the worker, as it does when it likes; the next one starts on the popup's word.
      const { targetInfos } = (await devtools.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
      const worker = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/worker.js"))!;
      const before = hellos.length;
      await devtools.send("Target.closeTarget", { targetId: worker.targetId });
      for (let i = 0; i < 100 && hellos.length === before; i++) {
        await popupSays({ type: "state" }).catch(() => undefined);
        await until(() => false, 100);
      }
      await until(() => hellos.length > before && device?.readyState === 1);
      expect(hellos.at(-1)?.["session"]).toEqual({ id: "r1", ended: "restarted" });
      expect((await call("tabs.list", { session: "r1" }))["error"]).toMatchObject({ code: "no_session" });
      await until(() => false, 300);
      expect(await debugged()).toBe(false);
      // Told once: the hello after that says nothing of it.
      const told = hellos.length;
      device!.close();
      await until(() => hellos.length > told, 15_000);
      expect(hellos.at(-1)?.["session"]).toBeUndefined();
    }, 45_000);
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
    // An ask KOS takes back while the owner is asked: answered as withdrawn, not as a no. (The card leaves by an animation,
    // which a page in a tab behind others never runs, so the newest card is the one asked about from here on.)
    const consentCard = "[...document.querySelectorAll('.ask-card--consent')].at(-1)";
    const withdrawn = call("session.begin", { session: "p0", task: "add the mug", requester: "Chrome", conversation: "chrome:owner", minutes: 15 });
    for (let i = 0; i < 100 && !(await devtools.evaluate(panel, `!!${consentCard}`)); i++) await until(() => false, 100);
    expect(await call("session.end", { session: "p0" })).toMatchObject({ ok: true });
    expect(await withdrawn).toMatchObject({ ok: true, result: { granted: false, reason: "withdrawn" } });
    // The panel's chat asks for a session: asked in the panel, no window of its own, with how long it waits, and granted for the
    // tab beside it, its site's steps unasked when the owner says so.
    const begun = call("session.begin", { session: "p1", task: "add the mug", requester: "Chrome", conversation: "chrome:owner", minutes: 15 });
    const cards = (): Promise<unknown> => devtools.evaluate(panel, "document.querySelectorAll('.ask-card--consent').length");
    const before = (await cards()) as number;
    for (let i = 0; i < 100 && ((await cards()) as number) <= before; i++) await until(() => false, 100);
    expect(await text()).toContain("add the mug");
    expect(await devtools.evaluate(panel, `${consentCard}.querySelector('.countdown').textContent`)).toMatch(/^lapses in (\d+s|1m 0s)$/);
    expect(await devtools.evaluate(panel, `${consentCard}.querySelector('.check').textContent`)).toBe(`And act on ${new URL(base).host} this session without asking`);
    await devtools.evaluate(panel, `${consentCard}.querySelector('.check input').click()`);
    await devtools.evaluate(panel, `${consentCard}.querySelector('.btn--primary').click()`);
    expect(await begun).toMatchObject({ ok: true, result: { granted: true, auto: { site: new URL(base).host } } });
    const listed = (await call("tabs.list", { session: "p1" }))["result"] as { tabs: { url: string; focus?: boolean; handed?: boolean }[] };
    expect(listed.tabs).toEqual([expect.objectContaining({ url: `${base}/beside`, focus: true, handed: true })]);
    expect(await call("session.end", { session: "p1" })).toMatchObject({ ok: true });
    // Words after the steps, the turn still going: the foot still says it works, until the turn ends.
    const foot = "document.querySelector('.working')";
    expect(await call("chat.status", { conversation: "chrome:owner", said: "Summarize this page", story: "› Read the page\nChecking the prices now." })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && !(await devtools.evaluate(panel, `!!${foot}?.querySelector('.live-dots')`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)).toMatch(/^Working\s*\d+s$/);
    expect(await text()).toContain("Checking the prices now.");
    // While it runs the send button is Stop, which stops the chat's turn.
    expect(await devtools.evaluate(panel, "document.querySelector('.send')?.getAttribute('aria-label')")).toBe("Stop");
    await devtools.evaluate(panel, "document.querySelector('.send--stop').click()");
    await until(() => events.some((e) => e.name === "chat.stop"));
    expect(events.find((e) => e.name === "chat.stop")?.data).toMatchObject({ chat: "chrome:owner", waited: expect.any(Number) });
    // Another chat's status, from a turn the owner moved away from, is not drawn here.
    expect(await call("chat.status", { chat: "cm1:owner", conversation: "cm1:owner", said: "elsewhere", story: "› Not here" })).toMatchObject({ ok: true });
    await until(() => false, 200);
    expect(await text()).not.toContain("Not here");
    // Held on an approval, the turn is the owner's to move: it says so, with no dots and no clock, and Approve comes first.
    expect(await call("chat.ask", { approval: { id: "a1", tool: "shell.run", reason: "runs a program", expiresAt: Date.now() + 60_000 } })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && (await devtools.evaluate(panel, `!!${foot}?.querySelector('.live-dots')`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)).toBe("Waiting on you");
    expect(await devtools.evaluate(panel, "[...document.querySelectorAll('.ask-card:not(.ask-card--consent):not(.ask-card--read) .row .btn')].map((b) => b.textContent)")).toEqual(["Approve", "Deny"]);
    expect(await text()).toContain("Asked because it runs a program.");
    expect(await devtools.evaluate(panel, "document.querySelector('.ask-card .countdown')?.textContent")).toMatch(/^lapses in (59|60|1m 0)s$/);
    expect(await call("chat.settled", { approval: "a1" })).toMatchObject({ ok: true });
    // The owner holds the chat's session: the foot says so, with Hand back and Stop.
    expect(await call("chat.status", { chat: "chrome:owner", conversation: "chrome:owner", held: true })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && !(await devtools.evaluate(panel, "!!document.querySelector('.working--held')")); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, "document.querySelector('.working--held').innerText")).toMatch(/Paused, you have control\s*Hand back\s*Stop/);
    expect(await call("chat.status", { chat: "chrome:owner", conversation: "chrome:owner", held: false })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && !(await devtools.evaluate(panel, `!!${foot}?.querySelector('.live-dots')`)); i++) await until(() => false, 100);
    expect(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)).toMatch(/^Working\s*\d+s$/);
    // Words queued behind it, taken once it is done: the next turn counts from its own start.
    const elapsed = async (): Promise<number> => Number(/(\d+)s$/.exec(String(await devtools.evaluate(panel, `${foot}?.innerText ?? ''`)))?.[1] ?? -1);
    for (let i = 0; i < 50 && (await elapsed()) < 2; i++) await until(() => false, 100);
    expect(await elapsed()).toBeGreaterThanOrEqual(2);
    expect(await call("chat.status", { conversation: "chrome:owner", taken: true, said: "And the shipping?" })).toMatchObject({ ok: true });
    await until(() => false, 200);
    expect(await elapsed()).toBeLessThan(2);
    expect(await call("chat.status", { conversation: "chrome:owner", story: null })).toMatchObject({ ok: true });
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
  it("keeps the popup one size, its page scrolling inside, between home, settings, the pairing form and an open drawer", async () => {
    // In front, as a popup always is: a tab behind others gets no frames, and its pages never finish moving.
    await devtools.send("Page.bringToFront", {}, popup);
    await devtools.send("Page.reload", {}, popup);
    await devtools.loaded(popup);
    const shown = async (js: string): Promise<void> => {
      for (let i = 0; i < 50 && !(await devtools.evaluate(popup, `!!(${js})`)); i++) await until(() => false, 100);
    };
    // What Chrome sizes its popup to: the body, its page scrolling inside it rather than past it.
    const size = async (): Promise<unknown> => {
      await until(() => false, 600);
      return devtools.evaluate(popup, "(() => { const b = document.body.getBoundingClientRect(); return [b.width, b.height, document.body.scrollHeight]; })()");
    };
    await shown("document.querySelector('.drawer-row')");
    const sizes = [await size()];
    await devtools.evaluate(popup, "document.querySelector('[aria-label=Settings]').click()");
    await shown("document.querySelector('.page-head')");
    sizes.push(await size());
    // Settings are longer than the popup: they scroll inside it.
    expect(await devtools.evaluate(popup, "(() => { const p = document.querySelector('.popup-page'); return p.scrollHeight > p.clientHeight; })()")).toBe(true);
    // Scrolled down, settings leave from where they are, and home comes in at its top.
    const scrolled = (await devtools.evaluate(popup, "(() => { const p = document.querySelector('.popup-page'); p.scrollTop = 200; return [p.scrollTop, document.querySelector('.page-head').getBoundingClientRect().top]; })()")) as [number, number];
    expect(scrolled[0]).toBe(200);
    const leaving = (await devtools.evaluate(
      popup,
      "new Promise((res) => { document.querySelector('[aria-label=Back]').click(); requestAnimationFrame(() => res([document.querySelector('.popup-page').scrollTop, document.querySelector('.page-head').getBoundingClientRect().top])); })",
    )) as [number, number];
    expect(leaving[0]).toBe(0);
    expect(Math.abs(leaving[1] - scrolled[1])).toBeLessThan(1);
    // Back again on the settings still leaving goes nowhere; settings called back mid-leave come in where they were, their scroll given back.
    const returned = (await devtools.evaluate(
      popup,
      "new Promise((res) => { document.querySelector('[aria-label=Back]').click(); document.querySelector('[aria-label=Settings]').click(); requestAnimationFrame(() => res([document.querySelector('.popup-page').scrollTop, document.querySelector('.page-head').getBoundingClientRect().top])); })",
    )) as [number, number];
    expect(returned[0]).toBe(200);
    expect(Math.abs(returned[1] - scrolled[1])).toBeLessThan(1);
    await shown("document.querySelectorAll('.page-head').length === 1 && !document.querySelector('[aria-label=Settings]')");
    await devtools.evaluate(popup, "document.querySelector('[aria-label=Back]').click()");
    await shown("document.querySelector('.drawer-row') && !document.querySelector('.page-head')");
    await devtools.evaluate(popup, "document.querySelector('.drawer-row').click()");
    await shown("document.querySelector('.drawer-row[aria-expanded=true]')");
    sizes.push(await size());
    await devtools.evaluate(popup, "[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Add a KOS')).click()");
    await shown("document.querySelector('.pair-form:not(.pair-form--again)')");
    sizes.push(await size());
    // The form, wherever it falls on the page, scrolled up into the popup's view.
    expect(await devtools.evaluate(popup, "(() => { const f = document.querySelector('.pair-form').getBoundingClientRect(); const p = document.querySelector('.popup-page').getBoundingClientRect(); return f.top >= p.top && f.top < p.bottom; })()")).toBe(true);
    expect(sizes).toEqual(Array(4).fill([392, 580, 580]));
  }, 30_000);
});
