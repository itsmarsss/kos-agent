import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChromeHost, findChrome } from "./chrome.js";
import { act, look, readAt, stepsOf, visit, type Tab } from "./hands.js";
import { BrowserLive, DEFAULT_CONFIG } from "./live.js";

/**
 * The hands on a real Chrome, headless, against pages served here: what a
 * fake cannot say is whether the clicks land, the dialogs close and the
 * waits end. Skipped where no Chrome is installed.
 */

const FORM = `<!doctype html><title>Form</title>
<main>
  <h1>Sign up</h1>
  <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value + ' from ' + document.getElementById('city').value + (document.getElementById('news').checked ? ' with news' : '')">
    <label>Name <input id="name"></label>
    <label>City <select id="city"><option value="">pick</option><option value="yyz">Toronto</option><option value="sfo">San Francisco</option></select></label>
    <label><input type="checkbox" id="news"> Newsletter</label>
    <button>Send</button>
  </form>
  <p id="out"></p>
  <button id="ask" onclick="document.getElementById('said').textContent = confirm('Delete everything?') ? 'yes' : 'no'">Delete</button>
  <p id="said"></p>
  <button id="late" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Arrived'; document.body.append(p); }, 400)">Later</button>
  <a href="/two">Next page</a>
</main>`;

const COVERED = `<!doctype html><title>Covered</title>
<button id="under" onclick="document.title='clicked'">Buy</button>
<div role="dialog" aria-label="Cookies" style="position:fixed;inset:0;background:#fff">We use cookies <button onclick="this.parentElement.remove()">Accept</button></div>`;

// A layer drawn over the page that the pointer goes through, as KOS's own border in the owner's Chrome is.
const VEILED = `<!doctype html><title>Veiled</title>
<button id="under" onclick="document.title='clicked'">Buy</button>
<div class="glow" style="position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 2px #7c9cff"></div>`;

const TWO = `<!doctype html><title>Two</title><main><p>The second page.</p><a href="https://example.com/far">Far away</a></main>`;

const chrome = findChrome(undefined);

describe.skipIf(!chrome)("the hands on a real Chrome", () => {
  let server: Server;
  let base = "";
  let profile = "";
  let live: BrowserLive;
  let host: ChromeHost;
  let tab: Tab;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = req.url === "/covered" ? COVERED : req.url === "/veiled" ? VEILED : req.url === "/two" ? TWO : req.url?.startsWith("/slow") ? "" : FORM;
      if (req.url?.startsWith("/slow")) {
        // A response that never ends: a page waiting on it is still loading.
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<!doctype html><title>Slow</title><p>Partly here");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    profile = mkdtempSync(join(tmpdir(), "kos-hands-"));
    const port = 9300 + Math.floor(Math.random() * 500);
    host = new ChromeHost({ port, profileDir: profile, launch: () => ({ windowSize: { width: 1200, height: 800 } }) });
    live = new BrowserLive({ config: () => DEFAULT_CONFIG, chrome: host, pageLimits: { domMs: 3_000, loadMs: 3_000 } });
    const id = await live.tabFor("test");
    tab = { page: await live.page(id), capture: (w) => live.capture(id, w) };
  }, 30_000);

  afterAll(async () => {
    await live?.shutdown();
    await host?.waitGone();
    host?.stop();
    server?.closeAllConnections();
    server?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("visits a page and sees its controls, with a picture", async () => {
    const seen = await visit(tab, [base], { then: "look" });
    expect(seen.text).toContain("Title: Form");
    expect(seen.text).toMatch(/textbox "Name" @e\d+/);
    expect(seen.text).toMatch(/combobox "City"/);
    expect(seen.text).toMatch(/checkbox "Newsletter" \[unchecked\]/);
    expect(seen.images).toHaveLength(1);
  });

  it("fills, picks, checks and sends a form, by refs that stay put", async () => {
    const first = await look(tab);
    const again = await look(tab);
    const ref = (text: string, line: RegExp): string => line.exec(text)![1]!;
    const name = ref(first.text, /textbox "Name" @(e\d+)/);
    expect(ref(again.text, /textbox "Name" @(e\d+)/)).toBe(name);
    const city = ref(first.text, /combobox "City"[^@]*@(e\d+)/);
    const news = ref(first.text, /checkbox "Newsletter"[^@]*@(e\d+)/);
    const send = ref(first.text, /button "Send" @(e\d+)/);
    const done = await act(
      tab,
      stepsOf([{ fill: { target: `@${name}`, text: "Ada" } }, { select: { target: `@${city}`, values: ["Toronto"] } }, { check: `@${news}` }, { click: `@${send}` }]),
      "read",
    );
    expect(done.text).toContain("Hello Ada from yyz with news");
    // Filling again replaces, rather than adds to, what is there.
    const twice = await act(tab, stepsOf([{ fill: { target: "#name", text: "Grace" } }, { press: "Enter" }]), "read");
    expect(twice.text).toContain("Hello Grace from yyz with news");
  });

  it("answers a dialog so nothing hangs, says what it said, and accepts when told", async () => {
    const dismissed = await act(tab, stepsOf([{ click: "#ask" }]), "read");
    expect(dismissed.text).toMatch(/confirm dialog said "Delete everything\?", and was dismissed/);
    expect(dismissed.text).toMatch(/\nno\n/);
    const accepted = await act(tab, stepsOf([{ dialog: "accept" }, { click: "#ask" }]), "read");
    expect(accepted.text).toMatch(/\nyes\n/);
  });

  it("waits for what a click makes appear", async () => {
    const done = await act(tab, stepsOf([{ click: "#late" }, { wait: { text: "Arrived" } }]), "none");
    expect(done.text).toContain('"Arrived" appeared');
  });

  it("refuses a click that would land on a dialog over the button, naming it", async () => {
    await visit(tab, [`${base}/covered`], { then: "none" });
    await expect(act(tab, stepsOf([{ click: "#under" }]), "none")).rejects.toThrow(/covered by <div> "We use cookies Accept"/);
    const seen = await look(tab);
    // The dialog's controls come first: it is what the page is waiting on.
    expect(seen.text).toMatch(/In the dialog "Cookies":\n {2}button "Accept"/);
    const done = await act(tab, stepsOf([{ click: "div[role=dialog] button" }, { click: "#under" }]), "none");
    expect(done.text).toContain("clicked #under");
  });

  it("clicks through a layer the pointer passes through, as a real click does", async () => {
    await visit(tab, [`${base}/veiled`], { then: "none" });
    const done = await act(tab, stepsOf([{ click: "#under" }]), "none");
    expect(done.text).toContain("clicked #under");
    expect(await tab.page.evaluate("document.title")).toBe("clicked");
  });

  it("follows a link, goes back, and reads a page with its links", async () => {
    await visit(tab, [base], { then: "none" });
    const seen = await look(tab);
    const next = /link "Next page" @(e\d+)/.exec(seen.text)![1]!;
    const moved = await act(tab, stepsOf([{ click: `@${next}` }]), "read");
    expect(moved.text).toContain(`Now at ${base}/two`);
    expect(moved.text).toContain("- Far away: https://example.com/far");
    const back = await act(tab, stepsOf([{ go: "back" }]), "none");
    expect(back.text).toContain("went back");
    expect(await readAt(tab, `${base}/two`, "main p")).toContain("The second page.");
  });

  it("hands back a page that will not finish loading as still loading, without failing", async () => {
    const seen = await visit(tab, [`${base}/slow`], { then: "none", until: "load" });
    expect(seen.text).toContain("still loading");
  });

  it("keeps the agent to the web", async () => {
    await expect(visit(tab, ["file:///etc/passwd"], { then: "none" })).rejects.toThrow(/file: addresses are not opened/);
    await expect(visit(tab, ["chrome://settings"], { then: "none" })).rejects.toThrow(/not opened/);
  });
});
