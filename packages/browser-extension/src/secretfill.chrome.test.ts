import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { echoPatterns } from "@kos/browser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { deviceProof, hostProof } from "./protocol.js";

/**
 * A saved secret filled into the owner's Chrome by the built extension, KOS
 * played here (docs/secrets.md, Protocol): secret.fill puts a value only
 * into the field, frame and origin approved, as Chrome says they are, and
 * refuses another origin, another frame, a hidden or read-only field, a GET
 * form, a page a service worker runs and a document that changed. The
 * field is checked to hold it without the value coming back; the tab then
 * refuses a script step, a copy and typing into the field; pictures mask
 * the field, and the page's echo where KOS sends its pattern. No value is in
 * anything the extension sent KOS, its log, its storage or what it tells
 * its pages. Skipped without a Chrome or a build.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const BUILT = existsSync(join(DIST, "worker.js"));

const rand = (n: number): string => [...randomBytes(n)].map((b) => (b % 36).toString(36)).join("");
const PASSWORD = `Pw-${rand(14)}`;
const CARD = `4${Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join("")}`;

/** The field's text in magenta, the page's echo of it in blue: a picture is read for each. */
const PAGE = (payOrigin: string): string => `<!doctype html><meta charset=utf-8><title>Sign in</title>
<style>input{font-size:28px;width:380px;height:44px;display:block;margin:6px}#pw{color:#ff00ff}#echo{color:#0000ff;font-size:34px}</style>
<form method=post action=/session>
<input id=user name=username type=text autocomplete=username>
<input id=pw name=password type=password autocomplete=current-password>
<input id=ro type=password readonly>
<input id=honey type=password style="opacity:0">
<input id=search type=search placeholder=Search>
</form>
<form method=get action=/find><input id=getpw type=password></form>
<div id=echo></div>
<iframe id=pay src="${payOrigin}/card" style="width:420px;height:80px;border:0"></iframe>
<script>
// Said back turned around, so only what the page says is found in what it reads, and the value itself nowhere.
const back = (v) => [...v].reverse().join('');
document.getElementById('pw').addEventListener('input', (e) => { document.getElementById('echo').textContent = back(e.target.value); document.title = 'typed ' + back(e.target.value); console.log('typed', e.target.value); });
</script>`;
/**
 * A page that watches itself for any sign of a picture's masking, started
 * by watch(): every mutation of its tree, and every change, polled, to its
 * highlights, its style sheets, its elements' style attributes and the
 * computed styles of its field and its echo, each kept in seen. It echoes
 * the password as typed, in magenta, beside a guess of its own.
 */
const ORACLE_PAGE = `<!doctype html><meta charset=utf-8><title>Oracle</title><style>input{font-size:28px;width:380px;height:44px;display:block;color:#ff00ff}</style>
<input id=pw type=password><div style="font-size:40px">guess-one <span id=echo style="color:#ff00ff"></span></div>
<script>window.seen = [];
const echo = document.getElementById('echo');
const pw = document.getElementById('pw');
pw.addEventListener('input', (e) => { echo.textContent = e.target.value; });
window.watch = () => {
  const note = (what) => window.seen.push(what);
  new MutationObserver((ms) => ms.forEach((m) => note(m.target.nodeName + ' ' + m.type + ':' + (m.attributeName || '')))).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const look = () => JSON.stringify([CSS.highlights.size, document.styleSheets.length, [...document.querySelectorAll('*')].map((el) => el.getAttribute('style')).join('|'), ...[pw, echo].flatMap((el) => { const c = getComputedStyle(el); return [c.color, c.webkitTextSecurity, c.textShadow]; })]);
  let last = look();
  setInterval(() => { const now = look(); if (now !== last) { note('style:' + now); last = now; } }, 1);
};</script>`;
const CARD_PAGE = `<!doctype html><meta charset=utf-8><input id=num autocomplete=cc-number style="font-size:24px;color:#ff00ff">`;
/** A page a service worker of its own runs, claimed as soon as it is in. */
const SW_PAGE = `<!doctype html><meta charset=utf-8><title>Worker</title><input id=wpw type=password style="font-size:24px">
<script>navigator.serviceWorker.register('/sw/sw.js', { scope: '/sw/' });</script>`;
const SW = "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));";

function rawKey(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

class Devtools {
  private id = 0;
  private readonly waiting = new Map<number, (m: Record<string, unknown>) => void>();
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

type DomNode = { backendNodeId: number; attributes?: string[]; frameId?: string; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };

describe.skipIf(!CHROME || !BUILT)("a saved secret filled into the owner's Chrome", { timeout: 60_000 }, () => {
  const host = generateKeyPairSync("ed25519");
  const hostRaw = host.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  let site: Server;
  let pay: Server;
  let sockets: WebSocketServer;
  let base = "";
  let payBase = "";
  let chrome: ChildProcess;
  let profile = "";
  let devtools: Devtools;
  let popup = "";
  let device: WebSocket | undefined;
  let deviceKey: KeyObject | undefined;
  /** Every frame the extension sent KOS, as sent. */
  const sent: string[] = [];
  const replies = new Map<number, (r: Record<string, unknown>) => void>();
  let nextCall = 1;
  let tab = "";

  const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 20_000);
      replies.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      device!.send(JSON.stringify({ t: "call", id, method, params: { session: "s1", ...params } }));
    });
  };
  const cdp = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const r = await call("cdp.send", { tab, method, params });
    if (r["error"]) throw new Error(JSON.stringify(r["error"]));
    return r["result"] as Record<string, unknown>;
  };
  const until = async (check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };

  /** The page as KOS's hands read it through the extension: the main frame, its document, each frame's origin, and each element by id with its frame. */
  const read = async (): Promise<{ main: string; doc: string; origins: Map<string, string>; byId: Map<string, { node: number; frame: string }> }> => {
    type Tree = { frame: { id: string; loaderId: string; securityOrigin: string }; childFrames?: Tree[] };
    const tree = (await cdp("Page.getFrameTree"))["frameTree"] as Tree;
    const origins = new Map<string, string>();
    const walkFrames = (t: Tree): void => {
      origins.set(t.frame.id, t.frame.securityOrigin);
      for (const c of t.childFrames ?? []) walkFrames(c);
    };
    walkFrames(tree);
    const byId = new Map<string, { node: number; frame: string }>();
    const walk = (n: DomNode | undefined, frame: string): void => {
      if (!n) return;
      const a = n.attributes ?? [];
      const id = a.indexOf("id");
      if (id >= 0 && id % 2 === 0) byId.set(a[id + 1]!, { node: n.backendNodeId, frame });
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c, frame);
      if (n.contentDocument && n.frameId) walk(n.contentDocument, n.frameId);
    };
    walk((await cdp("DOM.getDocument", { depth: -1, pierce: true }))["root"] as DomNode, tree.frame.id);
    return { main: tree.frame.id, doc: tree.frame.loaderId, origins, byId };
  };
  const fill = async (id: string, value: string, slot: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const page = await read();
    const field = page.byId.get(id)!;
    return call("secret.fill", { tab, node: field.node, frame: field.frame, doc: page.doc, origin: page.origins.get(page.main), frameOrigin: page.origins.get(field.frame), slot, value, ...over });
  };
  /** Pixels of a picture near a colour, counted in the test's own page. */
  const pixels = async (data: string, colour: "magenta" | "blue"): Promise<number> =>
    (await devtools.evaluate(
      popup,
      `new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) { const [r, gr, b] = [d[i], d[i + 1], d[i + 2]]; if (${colour === "magenta" ? "r > 190 && gr < 90 && b > 190" : "r < 70 && gr < 70 && b > 190"}) n++; }
        resolve(n); }; img.src = 'data:image/jpeg;base64,${data}'; })`,
    )) as number;

  beforeAll(async () => {
    pay = createServer((req, res) => {
      if (req.url === "/sw/sw.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(SW);
      if (req.url === "/sw/page") return void res.writeHead(200, { "content-type": "text/html" }).end(SW_PAGE);
      res.writeHead(200, { "content-type": "text/html" }).end(CARD_PAGE);
    });
    await new Promise<void>((r) => pay.listen(0, "127.0.0.1", r));
    payBase = `http://127.0.0.1:${(pay.address() as AddressInfo).port}`;
    site = createServer((req, res) => {
      if (req.url === "/api/devices/pair" && req.method === "POST") {
        res.setHeader("access-control-allow-origin", "*");
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const pair = JSON.parse(body) as { publicKey: string };
          deviceKey = rawKey(Buffer.from(pair.publicKey, "base64"));
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ device: "dev_test", hostKey: hostRaw.toString("base64"), protocol: 1 }));
        });
        return;
      }
      if (req.url === "/other") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Other</title><p>Other");
      if (req.url === "/oracle") return void res.writeHead(200, { "content-type": "text/html" }).end(ORACLE_PAGE);
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE(payBase));
    });
    sockets = new WebSocketServer({ server: site, path: "/api/devices/socket" });
    sockets.on("connection", (ws) => {
      const challenge = randomBytes(32).toString("base64");
      ws.send(JSON.stringify({ t: "challenge", protocol: 1, nonce: challenge }));
      ws.on("message", (raw) => {
        const text = raw.toString();
        sent.push(text);
        const m = JSON.parse(text) as Record<string, unknown>;
        if (m["t"] === "hello") {
          const id = String(m["device"]);
          if (!deviceKey || !verify(null, Buffer.from(deviceProof(challenge, id)), deviceKey, Buffer.from(String(m["signature"]), "base64"))) return ws.close(4003, "not paired");
          ws.send(JSON.stringify({ t: "welcome", name: "Test Chrome", signature: sign(null, Buffer.from(hostProof(String(m["nonce"]), id)), host.privateKey).toString("base64") }));
          device = ws;
        } else if (m["t"] === "ping") ws.send(JSON.stringify({ t: "pong" }));
        else if (m["t"] === "reply") replies.get(Number(m["id"]))?.(m);
      });
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    profile = mkdtempSync(join(tmpdir(), "kos-secretfill-"));
    const port = await freePort();
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging", "--no-first-run", "--use-mock-keychain", "about:blank"], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, HOME: "/tmp" },
    });
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 300 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => undefined);
      if (!version) await new Promise((r) => setTimeout(r, 100));
    }
    devtools = await Devtools.open(version!.webSocketDebuggerUrl);
    const { id } = (await devtools.send("Extensions.loadUnpacked", { path: DIST })) as { id: string };
    await devtools.send("Target.createTarget", { url: `chrome-extension://${id}/popup.html` });
    popup = await devtools.attach((u) => u.endsWith("/popup.html"));
    for (let i = 0; i < 50 && !(await devtools.evaluate(popup, "!!globalThis.chrome?.runtime?.id").catch(() => false)); i++) {
      await devtools.send("Page.reload", {}, popup).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    }
    const link = `kos-device://pair?url=${encodeURIComponent(base)}&code=test-code`;
    expect(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "pair", link: ${JSON.stringify(link)}, name: "Test Chrome" })`)).toMatchObject({ ok: true });
    await until(() => device !== undefined);
    // Its approvals decide: the session starts without the consent window.
    await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "askFirst", id: "dev_test", on: false })`);
    await until(() => false, 300);
    await until(() => device?.readyState === 1);
    expect(await call("session.begin", { task: "sign in", requester: "Test", minutes: 15 })).toMatchObject({ ok: true, result: { granted: true } });
    tab = ((await call("tabs.open", { url: `${base}/login` }))["result"] as { tab: string }).tab;
    await until(async () => (await read().catch(() => undefined))?.byId.has("num") === true);
  }, 60_000);

  afterAll(async () => {
    devtools?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((r) => chrome.once("exit", r));
      try {
        process.kill(-chrome.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      await exited;
    }
    sockets?.close();
    for (const s of [site, pay]) {
      s?.closeAllConnections();
      s?.close();
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("refuses another origin, another frame, a changed page and a field the secret may not go into", async () => {
    const page = await read();
    const refused = async (over: Record<string, unknown>, id = "pw", slot = "password"): Promise<unknown> => (await fill(id, PASSWORD, slot, over))["error"];
    expect(await refused({ origin: payBase })).toMatchObject({ code: "origin", message: expect.stringContaining(`the page is on ${base}`) });
    expect(await refused({ frameOrigin: payBase })).toMatchObject({ code: "origin" });
    // A field of the page named as one in the payment frame is not in the frame approved.
    const payFrame = page.byId.get("num")!.frame;
    expect(await refused({ frame: payFrame, frameOrigin: payBase })).toMatchObject({ code: "origin", message: expect.stringMatching(/not in the frame that was approved/) });
    expect(await refused({ doc: "an-older-document" })).toMatchObject({ code: "changed" });
    expect(await refused({}, "ro")).toMatchObject({ code: "field", message: expect.stringMatching(/read-only/) });
    expect(await refused({}, "honey")).toMatchObject({ code: "field", message: expect.stringMatching(/hidden/) });
    expect(await refused({}, "getpw")).toMatchObject({ code: "field", message: expect.stringMatching(/GET/) });
    expect(await refused({}, "search")).toMatchObject({ code: "field", message: expect.stringMatching(/search field does not take a password/) });
    expect(await refused({ slot: "pin" })).toMatchObject({ code: "bad_request" });
    for (const id of ["pw", "ro", "honey", "getpw", "search"]) expect(await devtools.evaluate(await devtools.attach((u) => u.endsWith("/login")), `document.getElementById(${JSON.stringify(id)}).value`)).toBe("");
  });

  it("fills only the field approved, holds it without saying it back, and the payment frame's on its own origin", async () => {
    expect(await fill("pw", PASSWORD, "password")).toMatchObject({ ok: true, result: { filled: true } });
    expect(await fill("user", "owner@example.com", "username")).toMatchObject({ ok: true, result: { filled: true } });
    expect(await fill("num", CARD, "card-number")).toMatchObject({ ok: true, result: { filled: true } });
    const page = await devtools.attach((u) => u.endsWith("/login"));
    expect(await devtools.evaluate(page, "document.getElementById('pw').value")).toBe(PASSWORD);
    expect(await devtools.evaluate(page, "document.getElementById('search').value")).toBe("");
    // The payment frame is on another origin: read from a world of the test's own in it.
    const payFrame = (await read()).byId.get("num")!.frame;
    const inFrame = ((await devtools.send("Page.createIsolatedWorld", { frameId: payFrame, worldName: "test" }, page)) as { executionContextId: number }).executionContextId;
    const num = (await devtools.send("Runtime.evaluate", { expression: "document.getElementById('num').value", contextId: inFrame, returnByValue: true }, page)) as { result: { value: string } };
    expect(num.result.value).toBe(CARD);
    // The extension's own world is not KOS's to reach.
    await devtools.send("Runtime.enable", {}, page);
    const own = devtools.heard.find((m) => m.sessionId === page && m.method === "Runtime.executionContextCreated" && (m.params["context"] as { name?: string }).name === "kos-secret");
    expect(own).toBeDefined();
    const ownId = (own!.params["context"] as { id: number }).id;
    expect((await call("cdp.send", { tab, method: "Runtime.evaluate", params: { expression: "1", contextId: ownId } }))["error"]).toMatchObject({ code: "method" });
  });

  it("holds the tab to the field: no script step, copy, drag or typing into it", async () => {
    const refused = { error: expect.objectContaining({ code: "tainted" }) };
    const send = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => call("cdp.send", { tab, method, params });
    // Said to KOS with the tab, so a new session on it holds it too.
    const listed = ((await call("tabs.list", {}))["result"] as { tabs: { id: string; held?: { loader: string; urls: string[] } }[] }).tabs;
    expect(listed.find((t) => t.id === tab)?.held).toEqual({ loader: (await read()).doc, urls: [`${base}/login`] });
    expect(await send("Runtime.evaluate", { expression: "document.getElementById('pw').value", replMode: true })).toMatchObject(refused);
    expect(await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4 })).toMatchObject(refused);
    expect(await send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", modifiers: 2 })).toMatchObject(refused);
    expect(await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", commands: ["selectAll"] })).toMatchObject(refused);
    for (const key of [
      { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45, modifiers: 2 },
      { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, modifiers: 8 },
      { key: "k", code: "KeyK", modifiers: 2, commands: ["deleteToEndOfParagraph"] },
      { key: "y", code: "KeyY", modifiers: 2, commands: ["yank"] },
    ]) {
      expect(await send("Input.dispatchKeyEvent", { type: "keyDown", ...key })).toMatchObject(refused);
    }
    expect(await send("Input.dispatchDragEvent", { type: "dragEnter", x: 10, y: 10, data: { items: [], dragOperationsMask: 1 } })).toMatchObject(refused);
    const { byId } = await read();
    // What the tree says each field holds stays in the browser: read here, and checked with every other frame sent at the end.
    const tree = JSON.stringify([await cdp("Accessibility.getFullAXTree"), await cdp("Accessibility.getFullAXTree", { frameId: byId.get("num")!.frame })]);
    expect(tree).toContain("(hidden)");
    await cdp("DOM.focus", { backendNodeId: byId.get("pw")!.node });
    expect(await send("Input.insertText", { text: "x" })).toMatchObject(refused);
    // Any editing command on the filled field, an undo among them; a paste on any tab, which would hand KOS the clipboard.
    expect(await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 4, commands: ["undo"] })).toMatchObject(refused);
    for (const key of [{ key: "v", code: "KeyV", modifiers: 4, commands: ["paste"] }, { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45, modifiers: 8 }]) {
      expect(await send("Input.dispatchKeyEvent", { type: "keyDown", ...key })).toMatchObject({ error: expect.objectContaining({ code: "method", message: expect.stringMatching(/paste/) }) });
    }
    // Another field takes typing and its editing commands, and the page's own address bar takes no script.
    await cdp("DOM.focus", { backendNodeId: byId.get("search")!.node });
    expect(await send("Input.insertText", { text: "shoes" })).toMatchObject({ ok: true });
    expect(await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 4, commands: ["undo"] })).toMatchObject({ ok: true });
    expect((await send("Page.navigate", { url: "javascript:alert(document.getElementById('pw').value)" }))["error"]).toMatchObject({ code: "url" });
  });

  it("masks the field in every picture, and the page's echo where KOS sends its pattern", async () => {
    const shot = (await cdp("Page.captureScreenshot", { format: "jpeg", quality: 90 }))["data"] as string;
    expect(await pixels(shot, "magenta")).toBe(0);
    // The echo is the page's own words: only the patterns KOS sends find it.
    expect(await pixels(shot, "blue")).toBeGreaterThan(50);
    const masks = { [base]: echoPatterns([{ text: [...PASSWORD].reverse().join(""), digits: false }], 1), [payBase]: echoPatterns([{ text: CARD, digits: true }], 1) };
    const masked = await call("secret.picture", { tab, format: "jpeg", quality: 90, masks });
    const data = (masked["result"] as { data: string }).data;
    expect(await pixels(data, "magenta")).toBe(0);
    expect(await pixels(data, "blue")).toBe(0);
    // Put back as it was.
    const page = await devtools.attach((u) => u.endsWith("/login"));
    expect(await devtools.evaluate(page, "document.getElementById('pw').getAttribute('style')")).toBeNull();
    expect(await devtools.evaluate(page, "CSS.highlights.has('kos-secret')")).toBe(false);
  });

  it("masks a picture with nothing a page can see: no mutation, style or highlight while it is taken", async () => {
    await cdp("Page.navigate", { url: `${base}/oracle` });
    await until(async () => (await read().catch(() => undefined))?.byId.has("pw") === true);
    expect(await fill("pw", PASSWORD, "password")).toMatchObject({ ok: true });
    const page = await devtools.attach((u) => u.endsWith("/oracle"));
    await devtools.evaluate(page, "window.watch()");
    await new Promise((r) => setTimeout(r, 50));
    const raw = ((await devtools.send("Page.captureScreenshot", { format: "jpeg", quality: 90 }, page)) as { data: string }).data;
    const held = (await cdp("Page.captureScreenshot", { format: "jpeg", quality: 90 }))["data"] as string;
    const masks = { [base]: echoPatterns([{ text: PASSWORD, digits: false }], 1) };
    const echoed = ((await call("secret.picture", { tab, format: "jpeg", quality: 90, masks }))["result"] as { data: string }).data;
    await new Promise((r) => setTimeout(r, 50));
    // KOS's cursor hides its halo for every picture, masked or not, which tells the page nothing of a secret; nothing else changed.
    const seen = JSON.parse(String(await devtools.evaluate(page, "JSON.stringify(window.seen)"))) as string[];
    expect(seen.filter((m) => m !== "KOS-OVERLAY attributes:data-capture")).toEqual([]);
    expect(await pixels(raw, "magenta")).toBeGreaterThan(200);
    // A held tab: every text box painted over; the echo only where KOS sends its pattern.
    expect(await pixels(held, "magenta")).toBeGreaterThan(200);
    expect(await pixels(echoed, "magenta")).toBe(0);
  });

  it("refuses a page a service worker runs, which KOS clears nowhere in the owner's Chrome", async () => {
    await cdp("Page.navigate", { url: `${payBase}/sw/page` });
    const worker = await devtools.attach((u) => u.endsWith("/sw/page"));
    await until(async () => (await devtools.evaluate(worker, "!!navigator.serviceWorker.controller").catch(() => false)) === true);
    expect(await fill("wpw", PASSWORD, "password")).toMatchObject({ error: { code: "worker" } });
    expect(await devtools.evaluate(worker, "document.getElementById('wpw').value")).toBe("");
  });

  it("lets go of the tab on a new page, and holds a page the secret was in when it comes back", async () => {
    const send = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => call("cdp.send", { tab, method, params });
    const step = { expression: "1 + 1", replMode: true, returnByValue: true };
    expect(await send("Runtime.evaluate", step)).toMatchObject({ ok: true });
    await cdp("Page.navigate", { url: `${base}/login` });
    expect(await send("Runtime.evaluate", step)).toMatchObject({ error: expect.objectContaining({ code: "tainted" }) });
    // Which field holds it again is not known: every text box's value is hidden from the tree.
    const back = await devtools.attach((u) => u.endsWith("/login"));
    await devtools.evaluate(back, "document.getElementById('search').value = 'restored-canary'");
    const tree = JSON.stringify(await cdp("Accessibility.getFullAXTree"));
    expect(tree).toContain("(hidden)");
    expect(tree).not.toContain("restored-canary");
    await cdp("Page.navigate", { url: `${base}/other` });
    expect(await send("Runtime.evaluate", step)).toMatchObject({ ok: true });
  });

  it("holds an address the page moved to by itself, come back to by history or afresh", async () => {
    const send = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => call("cdp.send", { tab, method, params });
    const step = { expression: "1 + 1", replMode: true, returnByValue: true };
    await cdp("Page.navigate", { url: `${base}/login?again` });
    await until(async () => (await read().catch(() => undefined))?.byId.has("pw") === true);
    expect(await fill("pw", PASSWORD, "password")).toMatchObject({ ok: true });
    const page = await devtools.attach((u) => u.endsWith("/login?again"));
    await devtools.evaluate(page, "history.pushState({}, '', '/moved')");
    await until(async () => JSON.stringify(await cdp("Page.getNavigationHistory")).includes("/moved"));
    await cdp("Page.navigate", { url: `${base}/other` });
    expect(await send("Runtime.evaluate", step)).toMatchObject({ ok: true });
    const history = (await cdp("Page.getNavigationHistory")) as { currentIndex: number; entries: { id: number; url: string }[] };
    const moved = history.entries.find((e) => e.url.endsWith("/moved"))!;
    await cdp("Page.navigateToHistoryEntry", { entryId: moved.id });
    await until(async () => JSON.stringify(await cdp("Page.getFrameTree")).includes("/moved"));
    expect(await send("Runtime.evaluate", step)).toMatchObject({ error: expect.objectContaining({ code: "tainted" }) });
    await cdp("Page.navigate", { url: `${base}/other` });
    await cdp("Page.navigate", { url: `${base}/moved` });
    expect(await send("Runtime.evaluate", step)).toMatchObject({ error: expect.objectContaining({ code: "tainted" }) });
    await cdp("Page.navigate", { url: `${base}/other` });
  });

  it("drives no page of Chrome's own or an extension's, gone to or stepped back to", async () => {
    const page = await devtools.attach((u) => u.endsWith("/other"));
    await devtools.send("Page.navigate", { url: "chrome://version/" }, page).catch(() => undefined);
    await until(async () => ((await call("cdp.send", { tab, method: "Page.getFrameTree", params: {} }))["error"] as { code?: string } | undefined)?.code === "url");
    expect(await call("cdp.send", { tab, method: "Page.getFrameTree", params: {} })).toMatchObject({ error: { code: "url" } });
    expect(await call("cdp.send", { tab, method: "Page.navigate", params: { url: `${base}/other` } })).toMatchObject({ error: { code: "url" } });
    // The owner goes back to the web; a step forward to Chrome's page is refused by where it goes.
    const there = await devtools.attach((u) => u.startsWith("chrome://version"));
    await devtools.send("Page.navigate", { url: `${base}/other` }, there);
    await until(async () => (await call("cdp.send", { tab, method: "Page.getFrameTree", params: {} }))["ok"] === true);
    const history = (await cdp("Page.getNavigationHistory")) as { entries: { id: number; url: string }[] };
    const chromePage = history.entries.find((e) => e.url.startsWith("chrome://"));
    expect(chromePage).toBeDefined();
    expect(await call("cdp.send", { tab, method: "Page.navigateToHistoryEntry", params: { entryId: chromePage!.id } })).toMatchObject({ error: { code: "url" } });
  });

  it("sends KOS, its log, its storage and its pages no value", async () => {
    const canaries = [PASSWORD, CARD, CARD.slice(-8)];
    const log = JSON.stringify(await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "log" })`));
    expect(log).toMatch(/secret\.fill: filled/);
    const kept = JSON.stringify([
      log,
      await devtools.evaluate(popup, "chrome.storage.local.get(null)"),
      await devtools.evaluate(popup, "chrome.storage.session.get(null)"),
      await devtools.evaluate(popup, `chrome.runtime.sendMessage({ type: "state" })`),
      sent,
    ]);
    for (const canary of canaries) expect(kept).not.toContain(canary);
  });
});
