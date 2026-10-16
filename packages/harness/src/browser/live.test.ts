import { describe, expect, it } from "vitest";

import type { CdpSocket } from "./cdp.js";
import type { ChromeHost } from "./chrome.js";
import { BrowserLive, browserEngine, inputCommand, launchFor, parseInput, sessionFor, type BrowserEvent } from "./live.js";

/**
 * KOS's eyes on the one Chrome: tabs and whose they are, a screencast of
 * the tab a watcher asks for, input to a tab, and a tab per engine session
 * in a window of its own.
 */

/** A Chrome that answers CDP the way the live view needs, in memory. */
class FakeChrome implements CdpSocket {
  sent: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  closed = false;
  targets: Record<string, unknown>[] = [];
  nextTarget = 1;
  /** Whether a screenshot comes back: a page that has painted. */
  still = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    const m = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
    this.sent.push(m);
    const reply = (result: Record<string, unknown>): void => this.onmessage?.({ data: JSON.stringify({ id: m.id, result }) });
    switch (m.method) {
      case "Target.getTargets":
        return reply({ targetInfos: this.targets });
      case "Target.createTarget": {
        const targetId = `T${this.nextTarget++}`;
        const url = typeof m.params["url"] === "string" ? m.params["url"] : "about:blank";
        this.targets.push({ targetId, type: "page", title: "", url });
        reply({ targetId });
        this.event("Target.targetCreated", { targetInfo: { targetId, type: "page", title: "", url } });
        return;
      }
      case "Target.attachToTarget":
        return reply({ sessionId: `S-${String(m.params["targetId"])}` });
      case "Page.captureScreenshot":
        return reply(this.still ? { data: "STILL" } : {});
      case "Page.getLayoutMetrics":
        return reply({ cssVisualViewport: { clientWidth: 1600, clientHeight: 1000 } });
      case "Target.closeTarget": {
        const id = String(m.params["targetId"]);
        this.targets = this.targets.filter((t) => t["targetId"] !== id);
        reply({ success: true });
        this.event("Target.targetDestroyed", { targetId: id });
        return;
      }
      case "Page.navigate":
        return reply(String(m.params["url"]).startsWith("bad:") ? { errorText: "net::ERR_INVALID_URL" } : { frameId: "F1" });
      case "Page.getNavigationHistory":
        return reply({ currentIndex: 1, entries: [{ id: 10 }, { id: 11 }] });
      case "Browser.close":
        reply({});
        this.onclose?.({});
        return;
      default:
        return reply({});
    }
  }
  close(): void {
    this.closed = true;
  }
  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.onmessage?.({ data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  }
  calls(method: string): { params: Record<string, unknown>; sessionId?: string }[] {
    return this.sent.filter((m) => m.method === method);
  }
}

type Host = ChromeHost & { exits: (() => void)[]; state: "stopped" | "starting" | "running"; starts: number; stops: number };

function fakeHost(): Host {
  const exits: (() => void)[] = [];
  const host = {
    state: "stopped" as "stopped" | "starting" | "running",
    port: 9225,
    exits,
    starts: 0,
    stops: 0,
    launch: { headed: false, found: "/opt/chrome" },
    onExit: (l: () => void) => {
      exits.push(l);
      return () => undefined;
    },
    ensure: async () => {
      host.state = "running";
      host.starts++;
      return "ws://127.0.0.1:9225/devtools/browser/fake";
    },
    lost: () => {
      host.state = "stopped";
    },
    stop: () => {
      host.stops++;
      host.state = "stopped";
    },
    waitGone: async () => undefined,
  };
  return host as unknown as Host;
}

function setup(engine = true) {
  const chrome = new FakeChrome();
  chrome.targets = [{ targetId: "T0", type: "page", title: "", url: "about:blank" }];
  const host = fakeHost();
  const reports: string[] = [];
  const downloads: unknown[] = [];
  let clock = 1000;
  const live = new BrowserLive({
    engineFor: () => (engine ? { server: "browser", port: 9225, headed: false, extensions: [], search: "https://duckduckgo.com/?q=%s" } : undefined),
    chrome: host,
    connect: () => {
      queueMicrotask(() => chrome.onopen?.({}));
      return chrome;
    },
    maxFps: 10,
    report: (m) => reports.push(m),
    downloadsDir: "/w/.kos/browser-downloads",
    onDownload: (d) => downloads.push(d),
    now: () => clock,
  });
  return { live, chrome, host, reports, downloads, tick: (ms: number) => { clock += ms; } };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("the live view of the one Chrome", () => {
  it("attaches on demand, lists the tabs, and tells watchers of changes", async () => {
    const { live, chrome, host } = setup();
    expect(live.status()).toMatchObject({ configured: true, chrome: "stopped", attached: false, tabs: [] });
    const seen: BrowserEvent[] = [];
    live.subscribe((e) => seen.push(e));
    await flush();
    expect(host.state).toBe("running");
    expect(live.status()).toMatchObject({ attached: true, tabs: [{ id: "T0", url: "about:blank" }] });
    expect(chrome.calls("Target.setDiscoverTargets")[0]?.params).toEqual({ discover: true });
    chrome.event("Target.targetInfoChanged", { targetInfo: { targetId: "T0", type: "page", title: "Example", url: "https://example.com/" } });
    expect(seen.at(-1)).toEqual({ type: "tabs", tabs: [{ id: "T0", title: "Example", url: "https://example.com/" }] });
  });

  it("refuses with no engine configured", async () => {
    const { live } = setup(false);
    await expect(live.ensure()).rejects.toThrow(/no browser engine/);
    expect(live.status().configured).toBe(false);
  });

  it("binds an engine session to a tab in its own window, once, and knows whose it is", async () => {
    const { live, chrome } = setup();
    const first = await live.bind("kos-c1", "c1");
    expect(first).toEqual({ target: "T1", retarget: true });
    expect(chrome.calls("Target.createTarget")[0]?.params).toEqual({ url: "about:blank", newWindow: true });
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T1", retarget: false });
    expect(live.tabOf("c1")).toBe("T1");
    expect(live.boundTab("kos-c1")).toBe("T1");
    expect(live.tabs()).toEqual([
      { id: "T0", title: "", url: "about:blank" },
      { id: "T1", title: "", url: "about:blank", owner: "c1" },
    ]);
    await live.tidy();
    expect(chrome.calls("Target.closeTarget").map((c) => c.params["targetId"])).toEqual(["T0"]);
    expect(live.tabs().map((t) => t.id)).toEqual(["T1"]);
    // The tab closing drops the binding, so the next bind makes a fresh one.
    chrome.event("Target.targetDestroyed", { targetId: "T1" });
    expect(live.tabOf("c1")).toBeUndefined();
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T2", retarget: true });
  });

  it("screencasts the watched tab, acks each frame, and stops when the last watcher leaves", async () => {
    const { live, chrome } = setup();
    await live.bind("kos-c1", "c1");
    const frames: BrowserEvent[] = [];
    const off = live.subscribe((e) => {
      if (e.type === "frame" || e.type === "gone") frames.push(e);
    }, "T1");
    await flush();
    expect(chrome.calls("Target.attachToTarget")[0]?.params).toEqual({ targetId: "T1", flatten: true });
    const cast = chrome.calls("Page.startScreencast")[0];
    expect(cast?.sessionId).toBe("S-T1");
    expect(cast?.params).toMatchObject({ format: "jpeg", everyNthFrame: 6 });
    chrome.event("Page.screencastFrame", { data: "AAAA", sessionId: 7, metadata: { deviceWidth: 1600, deviceHeight: 1000, timestamp: 1700000000.5 } }, "S-T1");
    expect(frames[0]).toEqual({ type: "frame", tab: "T1", frame: { seq: 1, data: "AAAA", width: 1600, height: 1000, at: 1700000000500 } });
    expect(chrome.calls("Page.screencastFrameAck")[0]).toMatchObject({ params: { sessionId: 7 }, sessionId: "S-T1" });
    off();
    await flush();
    expect(chrome.calls("Page.stopScreencast")[0]?.sessionId).toBe("S-T1");
  });

  it("takes the first picture of a still page, and replays the newest to a watcher who joins", async () => {
    const { live, chrome } = setup();
    chrome.still = true;
    await live.bind("kos-c1", "c1");
    const first: BrowserEvent[] = [];
    live.subscribe((e) => first.push(e), "T1");
    await flush();
    await flush();
    const shot = first.find((e) => e.type === "frame");
    expect(shot).toEqual({ type: "frame", tab: "T1", frame: { seq: 1, data: "STILL", width: 1600, height: 1000, at: expect.any(Number) } });
    const late: BrowserEvent[] = [];
    live.subscribe((e) => late.push(e), "T1");
    expect(late.find((e) => e.type === "frame")).toMatchObject({ frame: { data: "STILL" } });
    // Only one cast runs for the two of them.
    expect(chrome.calls("Page.startScreencast")).toHaveLength(1);
  });

  it("starts the cast again after a navigation, and pictures the page once it has loaded", async () => {
    const { live, chrome } = setup();
    chrome.still = true;
    await live.bind("kos-c1", "c1");
    const frames: BrowserEvent[] = [];
    live.subscribe((e) => {
      if (e.type === "frame") frames.push(e);
    }, "T1");
    await flush();
    await flush();
    expect(chrome.calls("Page.startScreencast")).toHaveLength(1);
    expect(frames).toHaveLength(1);
    chrome.event("Page.frameNavigated", { frame: { id: "F1", url: "https://example.com/" } }, "S-T1");
    await flush();
    await flush();
    expect(chrome.calls("Page.startScreencast")).toHaveLength(2);
    chrome.event("Page.loadEventFired", { timestamp: 1 }, "S-T1");
    await flush();
    await flush();
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.at(-1)).toMatchObject({ frame: { data: "STILL", width: 1600 } });
    // A child frame's navigation is not the page's.
    chrome.event("Page.frameNavigated", { frame: { id: "F2", parentId: "F1", url: "https://ads.example/" } }, "S-T1");
    await flush();
    expect(chrome.calls("Page.startScreencast")).toHaveLength(2);
  });

  it("pictures a tab scaled to fit, and knows which site a conversation is on", async () => {
    const { live, chrome } = setup();
    chrome.still = true;
    await live.bind("kos-c1", "c1");
    expect(live.siteOf("c1")).toBeUndefined();
    chrome.event("Target.targetInfoChanged", { targetInfo: { targetId: "T1", type: "page", title: "Shop", url: "https://shop.example.com/cart?x=1" } });
    expect(live.siteOf("c1")).toBe("shop.example.com");
    expect(live.siteOf("nobody")).toBeUndefined();
    expect(await live.capture("T1", 800)).toBe("STILL");
    const shot = chrome.calls("Page.captureScreenshot").at(-1);
    expect(shot?.params).toMatchObject({ format: "jpeg", clip: { x: 0, y: 0, width: 1600, height: 1000, scale: 0.5 } });
    expect(await live.capture("nope")).toBeUndefined();
  });

  it("tells a watcher of a tab that is not there, without starting anything", async () => {
    const { live, chrome } = setup();
    await live.bind("kos-c1", "c1");
    const seen: BrowserEvent[] = [];
    live.subscribe((e) => seen.push(e), "T-from-before");
    await flush();
    expect(seen.some((e) => e.type === "gone" && e.tab === "T-from-before")).toBe(true);
    expect(chrome.calls("Target.attachToTarget")).toHaveLength(0);
  });

  it("says when the watched tab closes", async () => {
    const { live, chrome } = setup();
    await live.bind("kos-c1", "c1");
    const seen: BrowserEvent[] = [];
    live.subscribe((e) => seen.push(e), "T1");
    await flush();
    chrome.event("Target.targetDestroyed", { targetId: "T1" });
    expect(seen.some((e) => e.type === "gone" && e.tab === "T1")).toBe(true);
  });

  it("passes input to the tab's session, only well-formed and only to a tab that exists", async () => {
    const { live, chrome } = setup();
    await live.bind("kos-c1", "c1");
    await live.input("T1", { type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 });
    await live.input("T1", { type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter" });
    const mouse = chrome.calls("Input.dispatchMouseEvent")[0];
    expect(mouse?.sessionId).toBe("S-T1");
    expect(mouse?.params).toEqual({ type: "mousePressed", x: 10, y: 20, modifiers: 0, button: "left", clickCount: 1 });
    expect(chrome.calls("Input.dispatchKeyEvent")[0]?.params).toMatchObject({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await expect(live.input("nope", { type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1 })).rejects.toThrow(/no such tab/);
    await expect(live.input("T1", { type: "config" })).rejects.toThrow(/unknown input type/);
    expect(() => parseInput({ type: "input_mouse", eventType: "mousePressed", x: "1", y: 2 })).toThrow(/must be a number/);
  });

  it("forgets everything when Chrome dies, and says so", async () => {
    const { live, chrome, host } = setup();
    await live.bind("kos-c1", "c1");
    const seen: BrowserEvent[] = [];
    live.subscribe((e) => seen.push(e), "T1");
    await flush();
    for (const l of host.exits) l();
    expect(chrome.closed).toBe(true);
    expect(live.status()).toMatchObject({ attached: false, chrome: "stopped", tabs: [] });
    expect(seen.some((e) => e.type === "gone")).toBe(true);
    expect(live.tabOf("c1")).toBeUndefined();
  });
});

describe("the owner's tabs, and an agent's second one", () => {
  it("opens a tab that is nobody's, sends it places, and closes it", async () => {
    const { live, chrome } = setup();
    const seen: BrowserEvent[] = [];
    live.subscribe((e) => seen.push(e));
    await flush();
    const tab = await live.openTab("https://example.com");
    expect(chrome.calls("Target.createTarget")[0]?.params).toEqual({ url: "https://example.com", newWindow: true });
    expect(live.tabs().find((t) => t.id === tab)).toEqual({ id: tab, title: "", url: "https://example.com" });
    expect(seen.filter((e) => e.type === "tabs").length).toBeGreaterThan(1);

    await live.navigate(tab, "https://example.org/a");
    expect(chrome.calls("Page.navigate")[0]).toMatchObject({ params: { url: "https://example.org/a" }, sessionId: `S-${tab}` });
    await expect(live.navigate(tab, "bad:url")).rejects.toThrow(/ERR_INVALID_URL/);
    await expect(live.navigate("nope", "https://x")).rejects.toThrow(/no such tab/);

    // History: at index 1 of 2 entries, back goes, forward has nowhere.
    expect(await live.history(tab, -1)).toBe(true);
    expect(chrome.calls("Page.navigateToHistoryEntry")[0]?.params).toEqual({ entryId: 10 });
    expect(await live.history(tab, 1)).toBe(false);
    await live.reload(tab);
    expect(chrome.calls("Page.reload")[0]?.sessionId).toBe(`S-${tab}`);

    // The owner's tab is not idle-closed: it is nobody's.
    expect(await live.closeIdle(0)).toEqual([]);
    await live.closeTab(tab);
    expect(live.tabs().map((t) => t.id)).not.toContain(tab);
    await expect(live.closeTab(tab)).rejects.toThrow(/no such tab/);
  });

  it("gives an agent a second tab of its own, which it is then on, and lists both as its", async () => {
    const { live } = setup();
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T1", retarget: true });
    const second = await live.openTab("https://example.com", { session: "kos-c1", conversationId: "c1" });
    expect(second).toBe("T2");
    expect(live.tabOf("c1")).toBe("T2");
    expect(live.tabs().filter((t) => t.owner === "c1").map((t) => t.id)).toEqual(["T1", "T2"]);
    // The engine is told once, on the next bind, then left alone.
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T2", retarget: true });
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T2", retarget: false });
    // Both go when the session idles out.
    expect(await live.closeIdle(0)).toEqual(["T1", "T2"]);
  });

  it("lets an agent take a tab, from the owner or from another agent, one holder at a time", async () => {
    const { live, chrome } = setup();
    const owners = await live.openTab("https://example.com");
    await live.bind("kos-c1", "c1");
    await live.bind("kos-c2", "c2");
    expect(() => live.useTab({ session: "kos-c1", conversationId: "c1" }, "nope")).toThrow(/no such tab/);

    live.useTab({ session: "kos-c1", conversationId: "c1" }, owners);
    expect(live.tabOf("c1")).toBe(owners);
    expect(live.tabs().find((t) => t.id === owners)?.owner).toBe("c1");
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: owners, retarget: true });

    // c2 takes it from c1, whose current tab moves back to its own.
    live.useTab({ session: "kos-c2", conversationId: "c2" }, owners);
    expect(live.tabOf("c2")).toBe(owners);
    expect(live.tabOf("c1")).toBe("T2");
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T2", retarget: true });
    expect(await live.bind("kos-c2", "c2")).toEqual({ target: owners, retarget: true });

    // Its current tab closing moves c2 to its other one, with the engine told.
    chrome.event("Target.targetDestroyed", { targetId: owners });
    expect(live.tabOf("c2")).toBe("T3");
    expect(await live.bind("kos-c2", "c2")).toEqual({ target: "T3", retarget: true });
  });

  it("closes Chrome and starts it again, dropping every tab", async () => {
    const { live, chrome, host } = setup();
    await live.bind("kos-c1", "c1");
    await live.restart();
    expect(chrome.calls("Browser.close")).toHaveLength(1);
    expect(host.stops).toBe(1);
    expect(host.starts).toBe(2);
    expect(live.status()).toMatchObject({ attached: true, chrome: "running" });
    expect(live.tabOf("c1")).toBeUndefined();
    expect(live.boundSessions()).toEqual([]);
  });
});

describe("downloads and idle tabs", () => {
  it("has Chrome stage downloads by guid, and says whose each finished one is", async () => {
    const { live, chrome, downloads } = setup();
    await live.bind("kos-c1", "c1");
    expect(chrome.calls("Browser.setDownloadBehavior")[0]?.params).toEqual({ behavior: "allowAndName", downloadPath: "/w/.kos/browser-downloads", eventsEnabled: true });
    chrome.event("Browser.downloadWillBegin", { frameId: "T1", guid: "g1", url: "https://x/report.pdf", suggestedFilename: "report.pdf" });
    chrome.event("Browser.downloadProgress", { guid: "g1", state: "inProgress", receivedBytes: 1, totalBytes: 2 });
    expect(downloads).toHaveLength(0);
    chrome.event("Browser.downloadProgress", { guid: "g1", state: "completed", receivedBytes: 2, totalBytes: 2 });
    expect(downloads).toEqual([{ guid: "g1", url: "https://x/report.pdf", suggestedFilename: "report.pdf", conversationId: "c1", stagingPath: "/w/.kos/browser-downloads/g1" }]);
    // A canceled one is forgotten; a stray tab's download has no owner.
    chrome.event("Browser.downloadWillBegin", { frameId: "T0", guid: "g2", url: "https://x/a", suggestedFilename: "a" });
    chrome.event("Browser.downloadProgress", { guid: "g2", state: "canceled" });
    chrome.event("Browser.downloadWillBegin", { frameId: "T0", guid: "g3", url: "https://x/b", suggestedFilename: "b" });
    chrome.event("Browser.downloadProgress", { guid: "g3", state: "completed" });
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).not.toHaveProperty("conversationId");
  });

  it("closes tabs nobody has used for a while, keeping the busy ones, and binds afresh after", async () => {
    const { live, tick } = setup();
    await live.bind("kos-c1", "c1");
    await live.bind("kos-c2", "c2");
    tick(10 * 60_000);
    live.touch("kos-c2");
    tick(15 * 60_000);
    // c1 idle 25 min, c2 idle 15 min; c3 would be busy.
    expect(await live.closeIdle(20 * 60_000)).toEqual(["T1"]);
    expect(live.tabOf("c1")).toBeUndefined();
    expect(live.tabOf("c2")).toBe("T2");
    tick(10 * 60_000);
    expect(await live.closeIdle(20 * 60_000, (id) => id === "c2")).toEqual([]);
    expect(await live.closeIdle(20 * 60_000)).toEqual(["T2"]);
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T3", retarget: true });
  });
});

describe("the engine in the MCP config, and the names things get", () => {
  it("is the enabled server naming the CDP port, with KOS's own keys read beside it", () => {
    expect(browserEngine({ servers: {} })).toBeUndefined();
    expect(browserEngine({ servers: { browser: { env: { AGENT_BROWSER_CDP: "9225" } } } })).toEqual({ server: "browser", port: 9225, headed: false, extensions: [], search: "https://duckduckgo.com/?q=%s" });
    const full = browserEngine({
      servers: {
        browser: {
          env: {
            AGENT_BROWSER_CDP: "9225",
            KOS_BROWSER_VIEWPORT: "1600x1000",
            KOS_BROWSER_CHROME: "/opt/chrome",
            KOS_BROWSER_HEADED: "1",
            KOS_BROWSER_EXTENSIONS: "/x/one, /x/two\n/x/three",
            KOS_BROWSER_SEARCH: "https://www.google.com/search?q=%s",
          },
        },
      },
    });
    expect(full).toEqual({
      server: "browser",
      port: 9225,
      headed: true,
      viewport: { width: 1600, height: 1000 },
      chrome: "/opt/chrome",
      extensions: ["/x/one", "/x/two", "/x/three"],
      search: "https://www.google.com/search?q=%s",
    });
    // A search with nowhere for the words falls back; the launch is the engine's settings as Chrome wants them.
    expect(browserEngine({ servers: { browser: { env: { AGENT_BROWSER_CDP: "9225", KOS_BROWSER_SEARCH: "https://example.com" } } } })?.search).toBe("https://duckduckgo.com/?q=%s");
    expect(launchFor(full)).toEqual({ headed: true, extensions: ["/x/one", "/x/two", "/x/three"], binary: "/opt/chrome", windowSize: { width: 1600, height: 1090 } });
    expect(launchFor(undefined)).toEqual({});
    expect(browserEngine({ servers: { browser: { enabled: false, env: { AGENT_BROWSER_CDP: "9225" } } } })).toBeUndefined();
    expect(browserEngine({ servers: { browser: { env: { AGENT_BROWSER_CDP: "ws" } } } })).toBeUndefined();
  });

  it("names a session for a conversation with only what the engine allows", () => {
    expect(sessionFor("cmv15h90o2:owner")).toBe("kos-cmv15h90o2-owner");
    expect(sessionFor("project:date_planner")).toBe("kos-project-date_planner");
  });

  it("turns a wheel into a wheel and a move into a buttonless move", () => {
    expect(inputCommand({ type: "input_mouse", eventType: "mouseWheel", x: 1, y: 2, deltaY: 100 }).params).toEqual({ type: "mouseWheel", x: 1, y: 2, modifiers: 0, button: "left", deltaX: 0, deltaY: 100 });
    expect(inputCommand({ type: "input_mouse", eventType: "mouseMoved", x: 1, y: 2 }).params).toMatchObject({ button: "none" });
    expect(inputCommand({ type: "input_keyboard", eventType: "char", text: "a" }).params).toEqual({ type: "char", modifiers: 0, text: "a" });
  });
});
