import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChromeHost, findChrome } from "./chrome.js";
import { act, evaluate, fieldSpots, fillSecrets, look, stepsOf, visit, type Tab } from "./hands.js";
import { BrowserLive, DEFAULT_CONFIG } from "./live.js";
import type { Session } from "./page.js";

/**
 * The per-site rule: on a site a saved secret may be filled on, no script of
 * KOS's runs, in any conversation, before or after a fill, or after a
 * restart; a page a script ran in takes no fill; and every saved value is
 * masked in every tab. Each case is an attack that worked on the
 * per-conversation rule alone. Skipped where no Chrome is installed.
 */

const PASSWORD = `Sym &=+%/?#"<>' x!`;
/** A saved secret for another site, which a page here might try to find out about. */
const ELSEWHERE = "orc-Saved-42xq9";

const page = (title: string, body: string): string => `<!doctype html><meta charset=utf-8><title>${title}</title><style>input{width:360px;height:44px;display:block}</style>${body}`;

describe.skipIf(!findChrome(undefined))("no script on a credential site", { timeout: 60_000 }, () => {
  let site: Server;
  let other: Server;
  let base = "";
  let otherBase = "";
  let scratch = "";
  let live: BrowserLive;
  let host: ChromeHost;
  /** Whether the vault knows the site yet: off, it is a site no secret is for. */
  let known = true;
  /** What reached the site's server through a service worker's hands, and what it was sent. */
  const stolen: string[] = [];
  const submitted: string[] = [];

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const html = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(body);
    // The site keeps its own copies of what is typed, as some do: in storage and a cookie.
    if (req.url === "/login")
      return html(
        page(
          "Sign in",
          `<label>Password <input id=pw type=password></label><script>document.getElementById('pw').addEventListener('input', (e) => { localStorage.setItem('kept', e.target.value); document.cookie = 'kept=' + encodeURIComponent(e.target.value) + '; path=/'; });</script>`,
        ),
      );
    if (req.url === "/stash") return html(page("Stash", `<p id=out></p><script>document.getElementById('out').textContent = 'Kept ' + localStorage.getItem('kept') + ' cookie ' + document.cookie;</script>`));
    // A worker that copies every POST it sees to /stolen before passing it on.
    if (req.url === "/sw.js")
      return void res
        .writeHead(200, { "content-type": "text/javascript" })
        .end(
          "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));" +
            "self.addEventListener('fetch', (e) => { if (e.request.method === 'POST') e.respondWith(e.request.clone().text().then((b) => fetch('/stolen?' + encodeURIComponent(b))).then(() => fetch(e.request))); });",
        );
    if (req.url?.startsWith("/stolen")) {
      stolen.push(req.url);
      return void res.writeHead(204).end();
    }
    if (req.url === "/submit") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => void submitted.push(body));
      return void res.writeHead(204).end();
    }
    if (req.url === "/swlogin")
      return html(page("Sign in", `<label>Password <input id=pw type=password></label><button id=go onclick="fetch('/submit', { method: 'POST', body: document.getElementById('pw').value })">Sign in</button>`));
    // A page that holds words a saved secret may be among, and watches for anything that marks one.
    if (req.url === "/oracle")
      return html(
        page(
          "Oracle",
          `<p>guess-one</p><p>${ELSEWHERE}</p><p>guess-two</p><script>window.told = []; new MutationObserver((ms) => { for (const m of ms) window.told.push(m.attributeName + ' ' + m.target.textContent); }).observe(document, { attributes: true, subtree: true }); setInterval(() => { if (CSS.highlights.size) window.told.push('highlight'); }, 5);</script>`,
        ),
      );
    if (req.url === "/opener") return html(page("Opener", `<label>Password <input id=pw type=password></label>`));
    if (req.url === "/framed") return html(page("Framed", `<iframe src="${base}/next"></iframe>`));
    html(page("Next", `<p>Elsewhere.</p>`));
  };

  const tabOf = async (conversationId: string): Promise<Tab> => {
    const id = await live.tabFor(conversationId);
    return { page: await live.page(id), capture: (w) => live.capture(id, w) };
  };
  const sessionOf = (t: Tab): Session => (t.page as unknown as { session: Session }).session;
  const peek = async (t: Tab, expression: string): Promise<unknown> =>
    ((await sessionOf(t).send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))["result"] as { value?: unknown }).value;
  const refOf = (seen: string, label: string): string => {
    const m = new RegExp(`"${label}"[^\\n]*@(e\\d+)`).exec(seen);
    if (!m) throw new Error(`no ref for ${label} in:\n${seen}`);
    return `@${m[1]}`;
  };
  const fill = async (t: Tab): Promise<void> => {
    const seen = (await visit(t, [`${base}/login`], { then: "look", until: "load" })).text;
    const pw = refOf(seen, "Password");
    await fillSecrets(t, [{ ref: pw, value: PASSWORD, expect: { ...(await fieldSpots(t, [pw]))[0]!, slot: "password" } }], "none");
  };
  const refused = /browser\.eval is refused on http:\/\/127\.0\.0\.1:\d+: a saved secret may be filled on this site/;

  const onSite = (origin: string): boolean => /^http:\/\/127\.0\.0\.1:/.test(origin);

  beforeAll(async () => {
    site = createServer(answer);
    other = createServer(answer);
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    otherBase = `http://localhost:${(other.address() as { port: number }).port}`;
    scratch = mkdtempSync(join(tmpdir(), "kos-persite-"));
    host = new ChromeHost({ port: 10_200 + Math.floor(Math.random() * 200), profileDir: join(scratch, "profile"), launch: () => ({ windowSize: { width: 1100, height: 900 } }) });
    const saved = [{ text: PASSWORD, digits: false }];
    const all = [...saved, { text: ELSEWHERE, digits: false }];
    live = new BrowserLive({
      config: () => DEFAULT_CONFIG,
      chrome: host,
      saved: () => all,
      savedFor: (origins) => (origins.some(onSite) ? saved : []),
      evalBlocked: (origin) => (known && onSite(origin) ? "a saved secret may be filled on this site" : undefined),
      workerSites: () => (known ? ["127.0.0.1"] : []),
    });
    await visit(await tabOf("warm"), [`${otherBase}/next`], { then: "none" });
  }, 60_000);

  afterAll(async () => {
    await live?.shutdown();
    await host?.waitGone();
    host?.stop();
    for (const s of [site, other]) {
      s?.closeAllConnections();
      s?.close();
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("runs no script on the site before a fill, so none can wait for it", async () => {
    const a = await tabOf("a");
    await visit(a, [`${base}/login`], { then: "none" });
    await expect(evaluate(a, "document.getElementById('pw').addEventListener('input', (e) => { window.name = e.target.value; }); 1")).rejects.toThrow(refused);
    await expect(evaluate(a, "1")).rejects.toThrow(/Looking, reading, acting with steps and browser\.handoff still work here/);
  });

  it("fills nothing into a page a script ran in, though the site was not known then", async () => {
    const a = await tabOf("a");
    known = false;
    try {
      await visit(a, [`${base}/login`], { then: "none" });
      await evaluate(a, "document.getElementById('pw').addEventListener('input', (e) => { window.name = e.target.value; }); 1");
    } finally {
      known = true;
    }
    const seen = (await look(a, "look")).text;
    const pw = refOf(seen, "Password");
    await expect(fillSecrets(a, [{ ref: pw, value: PASSWORD, expect: { ...(await fieldSpots(a, [pw]))[0]!, slot: "password" } }], "none")).rejects.toMatchObject({ code: "scripted" });
    expect(await peek(a, "window.name")).toBe("");
  });

  it("keeps another conversation from the site's own copies: no script, and its words masked", async () => {
    await fill(await tabOf("a"));
    const b = await tabOf("b");
    const read = await visit(b, [`${base}/stash`], { then: "read", until: "load" });
    expect(await peek(b, "localStorage.getItem('kept')")).toBe(PASSWORD);
    await expect(evaluate(b, "localStorage.getItem('kept') + document.cookie")).rejects.toThrow(refused);
    expect(read.text).toContain("Kept (hidden) cookie kept=(hidden)");
    expect(read.text).not.toContain(encodeURIComponent(PASSWORD));
  });

  it("runs no script on the site after the tainted page is left, and a page framing it reaches nothing", async () => {
    const a = await tabOf("a");
    await fill(a);
    await visit(a, [`${base}/next`], { then: "none" });
    await expect(evaluate(a, "btoa(localStorage.getItem('kept'))")).rejects.toThrow(refused);
    // A page elsewhere that frames the site runs in another process from it, and reaches nothing of it.
    await visit(a, [`${otherBase}/framed`], { then: "none", until: "load" });
    await expect(evaluate(a, "frames[0].localStorage.getItem('kept')")).rejects.toThrow(/the script threw/);
    // Elsewhere a script runs, and what it says is masked.
    await visit(a, [`${otherBase}/next`], { then: "none" });
    const said = await evaluate(a, `"said " + ${JSON.stringify(PASSWORD)}`);
    expect(said).toContain("said (hidden)");
    expect(said).not.toContain(PASSWORD);
  });

  it("registers no service worker on the site from any conversation", async () => {
    const c = await tabOf("c");
    await visit(c, [`${base}/next`], { then: "none", until: "load" });
    await expect(evaluate(c, "navigator.serviceWorker.register('/sw.js').then(() => 'registered')")).rejects.toThrow(refused);
    expect(await peek(c, "navigator.serviceWorker.getRegistrations().then((r) => r.length)")).toBe(0);
  });

  it("holds after a restart: no script on the site, and what it kept masked", async () => {
    await live.restart();
    const d = await tabOf("d");
    const read = await visit(d, [`${base}/stash`], { then: "read", until: "load" });
    expect(read.text).toContain("Kept (hidden)");
    await expect(evaluate(d, "localStorage.getItem('kept')")).rejects.toThrow(refused);
  });

  it("clears a service worker planted before the vault listed the site, so it catches no fill", async () => {
    const e = await tabOf("e");
    known = false;
    try {
      await visit(e, [`${base}/swlogin`], { then: "none", until: "load" });
      await evaluate(e, "await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; 1");
      // It works: a POST from the page goes through it.
      await visit(e, [`${base}/swlogin`], { then: "none", until: "load" });
      await peek(e, "fetch('/submit', { method: 'POST', body: 'probe' }).then(() => 1)");
      expect(stolen).toContain("/stolen?probe");
    } finally {
      known = true;
    }
    // The site is listed now: what the host does when the vault lists a site.
    await live.purgeWorkers(["127.0.0.1"]);
    expect(await peek(e, "navigator.serviceWorker.getRegistrations().then((r) => r.length)")).toBe(0);
    stolen.length = 0;
    const seen = (await visit(e, [`${base}/swlogin`], { then: "look", until: "load" })).text;
    const pw = refOf(seen, "Password");
    await fillSecrets(e, [{ ref: pw, value: PASSWORD, expect: { ...(await fieldSpots(e, [pw]))[0]!, slot: "password" } }], "none");
    await act(e, stepsOf([{ click: refOf(seen, "Sign in") }]), "none");
    await expect.poll(() => submitted.includes(PASSWORD), { timeout: 5_000 }).toBe(true);
    expect(stolen).toEqual([]);
  });

  it("tells a page elsewhere nothing of which of its words is a saved secret, and still cleans them from what KOS reads", async () => {
    const f = await tabOf("f");
    const read = await visit(f, [`${otherBase}/oracle`], { then: "read", until: "load" });
    expect(await f.capture(800)).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(await peek(f, "window.told")).toEqual([]);
    expect(read.text).toContain("guess-one");
    expect(read.text).not.toContain(ELSEWHERE);
  });

  it("takes no fill in a popup a scripted page opened, nor after the tab's hands are made again", async () => {
    const g = await tabOf("g");
    known = false;
    let kid = "";
    try {
      await visit(g, [`${otherBase}/next`], { then: "none", until: "load" });
      const before = live.tabsOf("g").length;
      await evaluate(g, `window.open(${JSON.stringify(`${base}/opener`)}, 'kid'); 1`);
      await expect.poll(() => live.tabsOf("g").length, { timeout: 5_000 }).toBeGreaterThan(before);
      kid = live.tabsOf("g").find((t) => t !== live.tabOf("g"))!;
    } finally {
      known = true;
    }
    try {
      const popup: Tab = { page: await live.page(kid), capture: (w) => live.capture(kid, w) };
      const seen = (await look(popup, "look")).text;
      const pw = refOf(seen, "Password");
      await expect(fillSecrets(popup, [{ ref: pw, value: PASSWORD, expect: { ...(await fieldSpots(popup, [pw]))[0]!, slot: "password" } }], "none")).rejects.toMatchObject({ code: "scripted" });
    } finally {
      await live.closeTab(kid);
    }
    // The tab's own scripted document stays refused though its Page is made anew.
    (live as unknown as { pages: Map<string, unknown> }).pages.delete(live.tabOf("g")!);
    const again = await tabOf("g");
    known = false;
    try {
      await visit(again, [`${base}/opener`], { then: "none", until: "load" });
      await evaluate(again, "1");
    } finally {
      known = true;
    }
    (live as unknown as { pages: Map<string, unknown> }).pages.delete(live.tabOf("g")!);
    const fresh = await tabOf("g");
    const seen = (await look(fresh, "look")).text;
    const pw = refOf(seen, "Password");
    await expect(fillSecrets(fresh, [{ ref: pw, value: PASSWORD, expect: { ...(await fieldSpots(fresh, [pw]))[0]!, slot: "password" } }], "none")).rejects.toMatchObject({ code: "scripted" });
  });
});
