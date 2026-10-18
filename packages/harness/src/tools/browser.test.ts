import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { ENGINE_TOOL, INDEX_MAX, compactIndex, createBrowserModule, parseStep, stepCall, touchesPage } from "./browser.js";

/**
 * A visit is one call: open, wait, look. A run of steps is one call too,
 * each step one engine gesture, and the page handed back after. A bad step
 * is refused before anything runs; a failing one says what got done.
 */

function harness(answers: Record<string, string | Error> = {}, look?: () => Promise<{ data: string } | undefined>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const registry = new ToolRegistry();
  const module = createBrowserModule({
    call: async (tool, args) => {
      calls.push({ tool, args });
      const a = answers[tool];
      if (a instanceof Error) throw a;
      return a ?? "";
    },
    ...(look ? { look } : {}),
  });
  return { calls, registry, module };
}

const HN = [
  "- link [ref=e102]",
  '- link "Hacker News" [ref=e103]',
  '- link "new" [ref=e104]',
  '- cell "1." [ref=e11]',
  '- cell "Hybrid Reasoning Agents (arxiv.org)" [ref=e12]',
  '  - link "Hybrid Reasoning Agents" [ref=e112]',
  '- link "new" [ref=e204]',
  "- textbox [ref=e300]",
  '- button "search" [ref=e301]',
].join("\n");

describe("browser.visit", () => {
  it("opens, waits for the DOM, and hands back the picture with a short index of what can be acted on", async () => {
    // A visit used to hand over the whole interactive tree, 14 KB for a news
    // page, before the model could think; the picture says more in fewer tokens.
    const h = harness({ [ENGINE_TOOL.title]: "Hacker News\n", [ENGINE_TOOL.snapshot]: HN }, async () => ({ data: "JPEG" }));
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const result = await h.registry.execute("browser.visit", { url: "https://news.ycombinator.com" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      [
        "Opened https://news.ycombinator.com",
        "Title: Hacker News",
        "Can be acted on:",
        'link "Hacker News" @e103',
        'link "new" @e104',
        'cell "1." @e11',
        'cell "Hybrid Reasoning Agents (arxiv.org)" @e12',
        'link "Hybrid Reasoning Agents" @e112',
        "textbox @e300",
        'button "search" @e301',
      ].join("\n"),
    );
    expect(result.images).toEqual([{ mediaType: "image/jpeg", data: "JPEG" }]);
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.open, ENGINE_TOOL.waitForLoad, ENGINE_TOOL.title, ENGINE_TOOL.snapshot]);
    expect(h.calls[1]?.args).toEqual({ state: "domcontentloaded" });
    expect(h.calls[3]?.args).toEqual({ interactive: true, compact: true });
    expect(h.registry.classify("browser.visit", {}).tier).toBe("safe");
  });

  it("says when there is no picture, waits for the full load when asked, and still gives the whole tree on request", async () => {
    const h = harness({ [ENGINE_TOOL.title]: "Example Domain\n", [ENGINE_TOOL.snapshot]: '- link "More" [ref=e1]' });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const result = await h.registry.execute("browser.visit", { url: "https://example.com", wait: "load" });
    expect(result.content).toBe('Opened https://example.com\nTitle: Example Domain\n(no picture of the tab was available)\nCan be acted on:\nlink "More" @e1');
    expect(result.images).toBeUndefined();
    expect(h.calls[1]?.args).toEqual({ state: "load" });
    const tree = await h.registry.execute("browser.visit", { url: "https://example.com", then: "snapshot" });
    expect(tree.content).toBe('Opened https://example.com\nTitle: Example Domain\n- link "More" [ref=e1]');
  });

  it("visits several pages in one call, each with its own picture", async () => {
    let n = 0;
    const h = harness({ [ENGINE_TOOL.title]: "T", [ENGINE_TOOL.snapshot]: '- button "Go" [ref=e1]' }, async () => ({ data: `J${(n += 1)}` }));
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const result = await h.registry.execute("browser.visit", { urls: ["https://a.example", "https://b.example"] });
    expect(result.content).toBe(['Opened https://a.example\nTitle: T\nCan be acted on:\nbutton "Go" @e1', 'Opened https://b.example\nTitle: T\nCan be acted on:\nbutton "Go" @e1'].join("\n\n"));
    expect(result.images).toEqual([{ mediaType: "image/jpeg", data: "J1" }, { mediaType: "image/jpeg", data: "J2" }]);
    expect(h.calls.filter((c) => c.tool === ENGINE_TOOL.open).map((c) => c.args["url"])).toEqual(["https://a.example", "https://b.example"]);
    expect((await h.registry.execute("browser.visit", { urls: ["a", "b", "c", "d", "e"].map((x) => `https://${x}.example`) })).content).toMatch(/at most four/);
    expect((await h.registry.execute("browser.visit", {})).content).toMatch(/url required/);
  });

  it("reads the page as text when asked, and scopes the index to a selector", async () => {
    const h = harness({ [ENGINE_TOOL.read]: "# Article\n\nWords." });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const read = await h.registry.execute("browser.visit", { url: "https://a.example/post", then: "read" });
    expect(read.content).toBe("Opened https://a.example/post\n# Article\n\nWords.");
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.open, ENGINE_TOOL.waitForLoad, ENGINE_TOOL.read]);
    h.calls.length = 0;
    await h.registry.execute("browser.visit", { url: "https://a.example/", scope: "main" });
    expect(h.calls.at(-1)?.args).toEqual({ interactive: true, compact: true, selector: "main" });
  });
});

describe("the index of a page", () => {
  it("names each control once, by role, label and ref, and leaves unlabeled links out", () => {
    const { lines, total } = compactIndex(HN);
    expect(lines).toEqual(['link "Hacker News" @e103', 'link "new" @e104', 'cell "1." @e11', 'cell "Hybrid Reasoning Agents (arxiv.org)" @e12', 'link "Hybrid Reasoning Agents" @e112', "textbox @e300", 'button "search" @e301']);
    expect(total).toBe(7);
  });

  it("caps the list and says how many there were", () => {
    const many = Array.from({ length: 120 }, (_, i) => `- link "item ${i}" [ref=e${i}]`).join("\n");
    const { lines, total } = compactIndex(many);
    expect(lines).toHaveLength(INDEX_MAX);
    expect(total).toBe(120);
    expect(compactIndex("nothing here")).toEqual({ lines: [], total: 0 });
  });
});

describe("browser.act", () => {
  it("runs the steps in order as engine calls, then looks", async () => {
    const h = harness({ [ENGINE_TOOL.snapshot]: "- after" });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const result = await h.registry.execute("browser.act", {
      steps: [{ fill: { selector: "@e2", text: "jane" } }, { select: { selector: "@e3", values: ["ca"] } }, { check: "@e4" }, { click: "@e5" }, { wait: 500 }, { scroll: "down" }, { press: "Enter" }],
      then: "snapshot",
    });
    expect(result.isError).toBe(false);
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.fill, ENGINE_TOOL.select, ENGINE_TOOL.check, ENGINE_TOOL.click, ENGINE_TOOL.waitMs, ENGINE_TOOL.scroll, ENGINE_TOOL.press, ENGINE_TOOL.title, ENGINE_TOOL.snapshot]);
    expect(h.calls[0]?.args).toEqual({ selector: "@e2", text: "jane" });
    expect(h.calls[1]?.args).toEqual({ selector: "@e3", values: ["ca"] });
    expect(result.content).toBe("Done: filled @e2; selected ca in @e3; checked @e4; clicked @e5; waited 500ms; scrolled down; pressed Enter.\n- after");
  });

  it("asks only when a step acts on the page", async () => {
    // A watcher that waited four seconds for a table to render was asking
    // the owner every six hours; a wait, a scroll or a visit changes nothing.
    const h = harness({});
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const tier = (input: Record<string, unknown>): string => h.registry.classify("browser.act", input).tier;
    expect(tier({ steps: [{ wait: 4000 }] })).toBe("safe");
    expect(tier({ steps: [{ open: "https://x" }, { wait: 500 }, { scroll: "down" }] })).toBe("safe");
    expect(tier({ steps: [{ wait: 500 }, { click: "@e1" }] })).toBe("risky");
    for (const step of [{ fill: { selector: "@e1", text: "x" } }, { type: { selector: "@e1", text: "x" } }, { press: "Enter" }, { select: { selector: "@e1", values: ["a"] } }, { check: "@e1" }, { uncheck: "@e1" }]) {
      expect(tier({ steps: [step] })).toBe("risky");
    }
    // Nothing to read, or a step the parser would refuse: asked, never run unasked.
    expect(tier({})).toBe("risky");
    expect(tier({ steps: [] })).toBe("risky");
    expect(tier({ steps: [{ wait: 500, click: "@e1" }] })).toBe("risky");
    expect(tier({ steps: ["wait"] })).toBe("risky");
    expect(touchesPage({ steps: [{ jump: "x" }] })).toBe(true);
  });

  it("refuses a malformed step before running any, and says where a run stopped", async () => {
    const h = harness({ [ENGINE_TOOL.click]: new Error("no element @e9") });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    const bad = await h.registry.execute("browser.act", { steps: [{ click: "@e1" }, { jump: "x" }] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/step 2: must have exactly one of/);
    expect(h.calls).toHaveLength(0);
    const failed = await h.registry.execute("browser.act", { steps: [{ press: "Tab" }, { click: "@e9" }, { press: "Enter" }] });
    expect(failed.isError).toBe(true);
    expect(failed.content).toBe("tool error: Done: pressed Tab. Step 2 failed (clicked): no element @e9");
    expect(h.calls.map((c) => c.tool)).toEqual([ENGINE_TOOL.press, ENGINE_TOOL.click]);
  });

  it("checks each step's shape", () => {
    expect(parseStep({ open: "https://x" }, 0)).toEqual({ open: "https://x" });
    expect(parseStep({ select: { selector: "@e1", value: "a" } }, 0)).toEqual({ select: { selector: "@e1", values: ["a"] } });
    expect(() => parseStep({ scroll: "sideways" }, 2)).toThrow(/step 3: scroll wants/);
    expect(() => parseStep({ wait: 99_999 }, 0)).toThrow(/up to 30000/);
    expect(() => parseStep({ fill: { selector: "@e1" } }, 0)).toThrow(/fill wants \{selector, text\}/);
    expect(() => parseStep("click", 0)).toThrow(/must be an object/);
    expect(stepCall({ type: { selector: "@e1", text: "hi" } })).toEqual({ tool: ENGINE_TOOL.type, args: { selector: "@e1", text: "hi" }, said: "typed into @e1" });
  });
});

describe("browser.handoff", () => {
  it("is risky, and once the owner has done it hands back where the tab is", async () => {
    const h = harness({ [ENGINE_TOOL.url]: "https://bank.example/home\n", [ENGINE_TOOL.title]: "Home" });
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(h.registry.classify("browser.handoff", { reason: "log in" }).tier).toBe("risky");
    const result = await h.registry.execute("browser.handoff", { reason: "log in" });
    expect(result.content).toBe("The owner has done it. The tab is now at https://bank.example/home (Home). Look again before you act.");
  });
});

describe("tabs", () => {
  it("lists the tabs with whose each is, moves to one, and opens one of its own", async () => {
    const h = harness({ [ENGINE_TOOL.title]: "Example", [ENGINE_TOOL.snapshot]: "- link @e1" });
    const used: string[] = [];
    const opened: (string | undefined)[] = [];
    const module = createBrowserModule({
      call: async (tool, args) => {
        h.calls.push({ tool, args });
        return tool === ENGINE_TOOL.title ? "Example" : tool === ENGINE_TOOL.snapshot ? "- link @e1" : "";
      },
      tabs: () => [
        { id: "T1", title: "Mine", url: "https://a", mine: true, current: true },
        { id: "T2", title: "", url: "https://b", owner: "Research" },
        { id: "T3", title: "Owner's", url: "https://c" },
      ],
      useTab: async (tab) => {
        used.push(tab);
      },
      newTab: async (url) => {
        opened.push(url);
        return "T9";
      },
    });
    await module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    for (const name of ["browser.tabs", "browser.use_tab", "browser.new_tab"]) expect(h.registry.classify(name, {}).tier).toBe("safe");

    expect((await h.registry.execute("browser.tabs", {})).content).toBe(
      "T1 (yours, current): Mine — https://a\nT2 (Research's): untitled — https://b\nT3 (the owner's): Owner's — https://c",
    );

    const moved = await h.registry.execute("browser.use_tab", { tab: "T3", then: "snapshot" });
    expect(used).toEqual(["T3"]);
    expect(moved.content).toBe("Now on tab T3.\nTitle: Example\n- link @e1");
    expect((await h.registry.execute("browser.use_tab", {})).isError).toBe(true);

    const fresh = await h.registry.execute("browser.new_tab", { url: "https://d", then: "none" });
    expect(opened).toEqual(["https://d"]);
    expect(fresh.content).toBe("Opened tab T9 at https://d.");
    expect(h.calls.map((c) => c.tool)).toContain(ENGINE_TOOL.waitForLoad);
    expect((await h.registry.execute("browser.new_tab", {})).content).toBe("Opened tab T9.");
  });

  it("watches a page: first look, no change, then the difference, told to the owner when asked", async () => {
    const h = harness();
    const looks = [
      { key: "prices", url: "https://shop.example/p", first: true, changed: false, changedAt: 1_000, seenAt: 1_000 },
      { key: "prices", url: "https://shop.example/p", first: false, changed: false, changedAt: 1_000, seenAt: 2_000 },
      { key: "prices", url: "https://shop.example/p", first: false, changed: true, changedAt: 3_000, seenAt: 3_000, diff: "- $40\n+ $35" },
    ];
    const asked: unknown[] = [];
    const told: string[] = [];
    const module = createBrowserModule({
      call: async () => "",
      watch: async (input) => {
        asked.push(input);
        return looks.shift()!;
      },
    });
    const services = { notify: async (p: { text: string }) => { told.push(p.text); return undefined; } };
    await module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m), services: services as never });
    expect(h.registry.classify("browser.watch", { url: "x" }).tier).toBe("safe");
    const first = await h.registry.execute("browser.watch", { url: "https://shop.example/p", name: "prices", selector: ".price" });
    expect(first.content).toBe("First look at prices: kept for next time.");
    expect(asked[0]).toEqual({ url: "https://shop.example/p", name: "prices", selector: ".price" });
    expect((await h.registry.execute("browser.watch", { url: "https://shop.example/p", name: "prices" })).content).toBe("No change at prices since 1970-01-01T00:00:01.000Z.");
    const moved = await h.registry.execute("browser.watch", { url: "https://shop.example/p", name: "prices", tell: true });
    expect(moved.content).toBe("Changed: prices\nhttps://shop.example/p\n- $40\n+ $35");
    expect(told).toEqual([moved.content]);
    expect((await h.registry.execute("browser.watch", {})).isError).toBe(true);
  });

  it("says when there is nothing to list", async () => {
    const h = harness();
    await h.module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect((await h.registry.execute("browser.tabs", {})).content).toBe("No tabs are open.");
  });
});

describe("browser.look", () => {
  it("hands back the tab as a picture, or says there is none", async () => {
    const h = harness();
    let shot: { data: string } | undefined = { data: "AAAA" };
    const module = createBrowserModule({ call: async () => "", look: async () => shot });
    await module.activate({ registerTool: (d, f, r, m) => h.registry.register(d, f, r, m) });
    expect(await h.registry.execute("browser.look", {})).toEqual({ content: "The tab as it is now.", isError: false, images: [{ mediaType: "image/jpeg", data: "AAAA" }] });
    expect(h.registry.classify("browser.look", {}).tier).toBe("safe");
    shot = undefined;
    expect((await h.registry.execute("browser.look", {})).content).toMatch(/no tab to look at/);
  });
});
