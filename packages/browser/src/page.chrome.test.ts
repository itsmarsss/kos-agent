import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChromeHost, findChrome } from "./chrome.js";
import { act, look, stepsOf, visit, type Tab } from "./hands.js";
import { BrowserLive, DEFAULT_CONFIG } from "./live.js";

/**
 * How long a step waits for the page to answer, and what a look finds, on a
 * real Chrome: a page that shows what a fetch brought only once it lands
 * must be seen with it, and a page that never stops talking (polls, a long
 * poll, a stream, beacons) must not hold every step to the most worth
 * waiting. Skipped where no Chrome is installed.
 */

const page = (title: string, body: string): string => `<!doctype html><meta charset=utf-8><title>${title}</title>${body}`;

/** A click whose answer is fetched, and shown when it lands. */
const FETCHED = page(
  "Fetched",
  `<button id=go onclick="fetch('/data').then(r => r.text()).then(t => { document.getElementById('out').textContent = t })">Load</button><p id=out></p>`,
);

/** A page that never goes quiet on the wire: polls that overlap, a long poll, a stream and beacons, all the time. */
const CHATTY = page(
  "Chatty",
  `<button id=go onclick="this.textContent='Pressed'">Press</button>
<script>
  setInterval(() => fetch('/poll?' + Math.random()), 100);
  setInterval(() => navigator.sendBeacon('/beacon', 'x'), 150);
  setInterval(() => { new Image().src = '/pixel?' + Math.random(); }, 100);
  fetch('/longpoll');
  new EventSource('/stream');
</script>`,
);

/** A page that changes in steps, each soon after the last. */
const STEPPED = page(
  "Stepped",
  `<button id=go onclick="let n = 0; const tick = () => { document.getElementById('out').textContent = 'step ' + (++n); if (n < 5) setTimeout(tick, 80); }; tick()">Run</button><p id=out></p>`,
);

/** A single-page app: a click moves the route and fetches what the new one shows. */
const SPA = page(
  "App",
  `<a href="/app/settings" id=go onclick="event.preventDefault(); history.pushState({}, '', this.href); fetch('/api/settings').then(r => r.json()).then(j => { document.getElementById('view').textContent = 'Settings for ' + j.user })">Settings</a><main id=view>Home</main>`,
);

const BIG = page(
  "Big",
  `<button id=b onclick="document.title='go'">Go</button>${Array.from({ length: 3000 }, (_, i) => `<div><a href="/p${i}">Product ${i}</a> <span>$${i}</span> <button onclick="document.title='added ${i}'">Add ${i}</button></div>`).join("")}`,
);

const HIDDEN = page(
  "Hidden",
  `<button>Shown</button>
<div style="display:none"><button>Not drawn</button></div>
<button style="visibility:hidden">Invisible</button>
<div aria-hidden="true"><button>Kept from readers</button></div>
<div inert><button>Inert</button></div>
<details><summary>More</summary><a href="/x">Folded away</a></details>
<button style="opacity:0">See-through</button>
<div style="display:contents"><button>In contents</button></div>`,
);

const NEXT = page("Next", `<main><p>The next page.</p></main>`);

/** What a reader would say that a page alone does not show: a closed shadow root, a frame still loading, presentation that cannot hide a control, aria-owns. */
const FIDELITY = page(
  "Fidelity",
  `<button>First</button><div aria-owns="late"></div><button>Second</button>
<button role="none">Still a button</button><div role="presentation" tabindex="0">Not a control</div>
<x-closed></x-closed>
<iframe src="/never" style="width:200px;height:60px"></iframe>
<button id="late">Late</button>
<script>customElements.define('x-closed', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<button>Inside closed</button>'; } });</script>`,
);

/** A search that asks the server a moment after the typing stops, as most do. */
const SEARCH = page(
  "Search",
  `<input id=q aria-label=Search><ul id=out></ul>
<script>let t; document.getElementById('q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => fetch('/search?q=' + encodeURIComponent(e.target.value)).then(r => r.text()).then(x => { document.getElementById('out').innerHTML = '<li>' + x + '</li>' }), 300) })</script>`,
);

/** A click whose answer takes its time: a second and a half, then read and drawn a moment later as an app's would be; or longer than any step waits. */
const SLOW = page(
  "Slow",
  `<button id=slow onclick="fetch('/slow').then(r => r.text()).then(t => setTimeout(() => { document.getElementById('out').textContent = t }, 150))">Slow</button>
<button id=slower onclick="fetch('/slower').then(r => r.text()).then(t => { document.getElementById('out').textContent = t })">Slower</button><p id=out></p>`,
);

describe.skipIf(!findChrome(undefined))("a page's answer and its controls, on a real Chrome", () => {
  let server: Server;
  let other: Server;
  let base = "";
  let otherBase = "";
  let profile = "";
  let live: BrowserLive;
  let host: ChromeHost;
  let tab: Tab;

  /** The second server: another origin of the same site, and another site (by name). */
  const framed = (): string =>
    page(
      "Framed",
      `<button>Top</button><div id=host></div>
<script>addEventListener('message', (e) => { document.title = e.data });
document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button onclick="document.title=\\'shadow\\'">In shadow</button>'</script>
<iframe src="/inner" style="width:300px;height:80px"></iframe>
<iframe src="${otherBase}/inner" style="width:300px;height:80px"></iframe>
<iframe src="${otherBase.replace("127.0.0.1", "localhost")}/inner" style="width:300px;height:80px"></iframe>`,
    );

  /** A click whose answer comes from another site's API, after a while. */
  const elsewhere = (): string =>
    page(
      "Elsewhere",
      `<button id=go onclick="fetch('${otherBase.replace("127.0.0.1", "localhost")}/api/late').then(r => r.text()).then(t => { document.getElementById('out').textContent = t })">Load</button><p id=out></p>`,
    );

  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? "/";
    const html = (body: string): void => void res.writeHead(200, { "content-type": "text/html" }).end(body);
    // A frame's page that never comes.
    if (url === "/never") return;
    if (url === "/data") return void setTimeout(() => res.end("Arrived from the server"), 300);
    if (url === "/api/late") return void setTimeout(() => res.writeHead(200, { "access-control-allow-origin": "*" }).end("Arrived from another site"), 400);
    if (url.startsWith("/search")) return void setTimeout(() => res.end(`Results for ${new URL(url, base).searchParams.get("q")}`), 100);
    if (url === "/slow") return void setTimeout(() => res.end("Slow, but here"), 1_500);
    if (url === "/slower") return void setTimeout(() => res.end("Too late"), 4_000);
    if (url.startsWith("/poll")) return void setTimeout(() => res.end("ok"), 300);
    if (url === "/longpoll" || url === "/stream") {
      res.writeHead(200, { "content-type": url === "/stream" ? "text/event-stream" : "text/plain" });
      return void res.write(url === "/stream" ? ": open\n\n" : "");
    }
    if (url.startsWith("/beacon") || url.startsWith("/pixel")) return void res.writeHead(204).end();
    if (url === "/api/settings") return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"user":"Ada"}'), 200);
    if (url === "/inner") return html(page("Inner", `<button onclick="parent.postMessage('inner ' + location.port, '*')">Inner button</button>`));
    const pages: Record<string, string> = { "/elsewhere": elsewhere(), "/fidelity": FIDELITY, "/finder": SEARCH, "/waiting": SLOW, "/fetched": FETCHED, "/chatty": CHATTY, "/stepped": STEPPED, "/app": SPA, "/big": BIG, "/hidden": HIDDEN, "/next": NEXT, "/framed": framed() };
    html(pages[url] ?? page("Start", `<a id=go href="/next">Next</a>`));
  };

  beforeAll(async () => {
    server = createServer(answer);
    other = createServer(answer);
    for (const s of [server, other]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const portOf = (s: Server): number => {
      const a = s.address();
      return typeof a === "object" && a ? a.port : 0;
    };
    base = `http://127.0.0.1:${portOf(server)}`;
    otherBase = `http://127.0.0.1:${portOf(other)}`;
    profile = mkdtempSync(join(tmpdir(), "kos-page-"));
    host = new ChromeHost({ port: 9800 + Math.floor(Math.random() * 150), profileDir: profile, launch: () => ({ windowSize: { width: 1200, height: 800 } }) });
    live = new BrowserLive({ config: () => DEFAULT_CONFIG, chrome: host });
    const id = await live.tabFor("test");
    tab = { page: await live.page(id), capture: (w) => live.capture(id, w) };
  }, 30_000);

  afterAll(async () => {
    await live?.shutdown();
    await host?.waitGone();
    host?.stop();
    for (const s of [server, other]) {
      s?.closeAllConnections();
      s?.close();
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const start = Date.now();
    const value = await work();
    return { value, ms: Date.now() - start };
  };

  it("sees what a click fetched, once it has landed", async () => {
    await visit(tab, [`${base}/fetched`], { then: "none" });
    const { value } = await timed(() => act(tab, stepsOf([{ click: "#go" }]), "read"));
    expect(value.text).toContain("Arrived from the server");
  });

  it("sees what a click fetched from another site's API, once it has landed", async () => {
    await visit(tab, [`${base}/elsewhere`], { then: "none" });
    const done = await act(tab, stepsOf([{ click: "#go" }]), "read");
    expect(done.text).toContain("Arrived from another site");
  });

  it("waits for a search that asks a moment after the typing stops", async () => {
    await visit(tab, [`${base}/finder`], { then: "none" });
    const done = await act(tab, stepsOf([{ type: { target: "#q", text: "kos" } }]), "read");
    expect(done.text).toContain("Results for kos");
  });

  it("waits out a slow answer, and says when one takes longer than a step waits", async () => {
    await visit(tab, [`${base}/waiting`], { then: "none" });
    const slow = await act(tab, stepsOf([{ click: "#slow" }]), "read");
    expect(slow.text).toContain("Slow, but here");
    expect(slow.text).not.toContain("may still be loading");
    const slower = await act(tab, stepsOf([{ click: "#slower" }]), "none");
    expect(slower.text).toContain("The page may still be loading");
  });

  it("tells polls from answers: polls that overlap, a long poll, a stream and beacons hold no step", async () => {
    // Were the polls taken for answers, one is always open, and each step would wait its longest and say the page may still be loading.
    const opened = await visit(tab, [`${base}/chatty`], { then: "none" });
    expect(opened.text).not.toContain("may still be loading");
    for (let i = 0; i < 3; i++) {
      const clicked = await act(tab, stepsOf([{ click: "#go" }]), "read");
      expect(clicked.text).toContain("Pressed");
      expect(clicked.text).not.toContain("may still be loading");
    }
  });

  it("waits out a page that changes in quick steps", async () => {
    await visit(tab, [`${base}/stepped`], { then: "none" });
    const done = await act(tab, stepsOf([{ click: "#go" }]), "read");
    expect(done.text).toContain("step 5");
  });

  it("follows a click to the page it opens", async () => {
    await visit(tab, [base], { then: "none" });
    const done = await act(tab, stepsOf([{ click: "#go" }]), "read");
    expect(done.text).toContain(`Now at ${base}/next`);
    expect(done.text).toContain("The next page.");
  });

  it("sees a single-page app's new route once its data has come", async () => {
    await visit(tab, [`${base}/app`], { then: "none" });
    const done = await act(tab, stepsOf([{ click: "#go" }]), "read");
    expect(done.text).toContain(`Now at ${base}/app/settings`);
    expect(done.text).toContain("Settings for Ada");
  });

  it("ends a step under way when the owner presses Stop, and works on after", async () => {
    await visit(tab, [`${base}/fetched`], { then: "none" });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 900);
    const stopped = await timed(() => act(tab, stepsOf([{ click: "#go" }, { wait: { text: "never there" } }, { click: "#go" }]), "look", stop.signal).catch((err: Error) => err.message));
    expect(stopped.value).toBe("Done: clicked #go. Stopped by the owner during step 2.");
    // The wait would have run its fifteen seconds.
    expect(stopped.ms).toBeLessThan(8_000);
    const after = await act(tab, stepsOf([{ click: "#go" }]), "read");
    expect(after.text).toContain("Arrived from the server");
  });

  it("indexes a big page quickly, capped, with refs that act", async () => {
    await visit(tab, [`${base}/big`], { then: "none" });
    await look(tab);
    const { value: seen, ms } = await timed(() => look(tab));
    // Read in the page in one go; the bound is generous, for a loaded CI machine.
    expect(ms).toBeLessThan(2_500);
    expect(seen.text).toContain("(some of 6001;");
    const lines = seen.text.split("\n").filter((l) => /@e\d+/.test(l));
    expect(lines).toHaveLength(60);
    expect(lines[0]).toMatch(/^button "Go" @e1$/);
    const add = /button "Add 3" @(e\d+)/.exec(seen.text)![1]!;
    await act(tab, stepsOf([{ click: `@${add}` }]), "none");
    expect(await tab.page.evaluate("document.title")).toBe("added 3");
  });

  it("leaves out what is not drawn or is kept from readers", async () => {
    const seen = await visit(tab, [`${base}/hidden`], { then: "look" });
    for (const shown of ["Shown", "See-through", "In contents"]) expect(seen.text).toContain(`button "${shown}"`);
    for (const hidden of ["Not drawn", "Invisible", "Kept from readers", "Inert", "Folded away"]) expect(seen.text).not.toContain(hidden);
  });

  it("reads open shadow roots and the frames it can reach, says which it could not, and acts in them", async () => {
    const seen = await visit(tab, [`${base}/framed`], { then: "look", until: "load" });
    expect(seen.text).toMatch(/button "Top" @e1\nbutton "In shadow" @e2\nbutton "Inner button" @e3\nbutton "Inner button" @e4/);
    expect(seen.text).toMatch(/Not read: an embedded frame from localhost:\d+/);
    await act(tab, stepsOf([{ click: "@e2" }]), "none");
    expect(await tab.page.evaluate("document.title")).toBe("shadow");
    // The frame of another origin, read in a world of its own, is acted in by its ref too.
    await act(tab, stepsOf([{ click: "@e4" }]), "none");
    expect(await tab.page.evaluate("document.title")).toBe(`inner ${new URL(otherBase).port}`);
    const outline = await look(tab, "snapshot");
    expect(outline.text).toContain('button "Inner button"');
  });

  it("reads what a page owns where it owns it, keeps a control marked as presentation, and says what it could not read", async () => {
    const seen = await visit(tab, [`${base}/fidelity`], { then: "look" });
    const lines = seen.text.split("\n").filter((l) => /@e\d+/.test(l)).map((l) => l.replace(/ @e\d+.*/, ""));
    expect(lines).toEqual(['button "First"', 'button "Late"', 'button "Second"', 'button "Still a button"']);
    expect(seen.text).toContain("Not read: a part of the page closed to scripts");
    expect(seen.text).toMatch(/Not read: an embedded frame from 127\.0\.0\.1:\d+/);
  });

  it("looks only inside a scope, and says when nothing matches it", async () => {
    await visit(tab, [`${base}/big`], { then: "none" });
    const scoped = await look(tab, "look", "div:nth-of-type(2)");
    const lines = scoped.text.split("\n").filter((l) => /@e\d+/.test(l));
    expect(lines.map((l) => l.replace(/ @e\d+.*/, ""))).toEqual(['link "Product 1"', 'button "Add 1"']);
    await expect(look(tab, "look", "#nothing-here")).rejects.toThrow(/nothing on the page matches #nothing-here/);
    await expect(look(tab, "look", "[[bad")).rejects.toThrow(/is not a selector I can use/);
  });
});
