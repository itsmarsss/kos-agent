import { describe, expect, it } from "vitest";

import type { CdpSocket } from "./cdp.js";
import type { ChromeHost } from "./chrome.js";
import { BrowserLive, browserEngine, inputCommand, parseInput, sessionFor, type BrowserEvent } from "./live.js";

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
        this.targets.push({ targetId, type: "page", title: "", url: "about:blank" });
        reply({ targetId });
        this.event("Target.targetCreated", { targetInfo: { targetId, type: "page", title: "", url: "about:blank" } });
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

type Host = ChromeHost & { exits: (() => void)[]; state: "stopped" | "starting" | "running" };

function fakeHost(): Host {
  const exits: (() => void)[] = [];
  const host = {
    state: "stopped" as "stopped" | "starting" | "running",
    port: 9225,
    exits,
    onExit: (l: () => void) => {
      exits.push(l);
      return () => undefined;
    },
    ensure: async () => {
      host.state = "running";
      return "ws://127.0.0.1:9225/devtools/browser/fake";
    },
    lost: () => {
      host.state = "stopped";
    },
    stop: () => undefined,
  };
  return host as unknown as Host;
}

function setup(engine = true) {
  const chrome = new FakeChrome();
  chrome.targets = [{ targetId: "T0", type: "page", title: "", url: "about:blank" }];
  const host = fakeHost();
  const reports: string[] = [];
  const live = new BrowserLive({
    engineFor: () => (engine ? { server: "browser", port: 9225, headed: false } : undefined),
    chrome: host,
    connect: () => {
      queueMicrotask(() => chrome.onopen?.({}));
      return chrome;
    },
    maxFps: 10,
    report: (m) => reports.push(m),
  });
  return { live, chrome, host, reports };
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
    expect(first).toEqual({ target: "T1", made: true });
    expect(chrome.calls("Target.createTarget")[0]?.params).toEqual({ url: "about:blank", newWindow: true });
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T1", made: false });
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
    expect(await live.bind("kos-c1", "c1")).toEqual({ target: "T2", made: true });
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

describe("the engine in the MCP config, and the names things get", () => {
  it("is the enabled server naming the CDP port, with KOS's own keys read beside it", () => {
    expect(browserEngine({ servers: {} })).toBeUndefined();
    expect(browserEngine({ servers: { browser: { env: { AGENT_BROWSER_CDP: "9225" } } } })).toEqual({ server: "browser", port: 9225, headed: false });
    expect(
      browserEngine({ servers: { browser: { env: { AGENT_BROWSER_CDP: "9225", KOS_BROWSER_VIEWPORT: "1600x1000", KOS_BROWSER_CHROME: "/opt/chrome", KOS_BROWSER_HEADED: "1" } } } }),
    ).toEqual({ server: "browser", port: 9225, headed: true, viewport: { width: 1600, height: 1000 }, chrome: "/opt/chrome" });
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
