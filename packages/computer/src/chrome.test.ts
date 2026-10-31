import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { attendance, openDatabase, type ModuleContext, type ToolRisk } from "@kos/harness";

import { OwnerChrome } from "./chrome.js";
import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { DeviceStore } from "./store.js";
import { computerModule } from "./tools.js";

/**
 * The owner's Chrome, paired through the KOS extension: a device that offers
 * tabs. Its session is asked for like a computer's; while a chat has one,
 * that chat's browser tools are driven through the extension.
 */

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
type Handler = (input: Record<string, unknown>) => unknown;

function setup() {
  const hub = new DeviceHub({
    store: new DeviceStore(openDatabase(":memory:")),
    hostKey: { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) },
    halted: () => false,
    beginTimeoutMs: 200,
    callTimeoutMs: 500,
  });
  const chrome = new OwnerChrome(hub);
  const tools = new Map<string, Handler>();
  const risks = new Map<string, ToolRisk | undefined>();
  const ctx: ModuleContext = {
    registerTool: (def, handler, risk) => {
      tools.set(def.name, handler as Handler);
      risks.set(def.name, risk);
    },
    unregisterTool: (name) => tools.delete(name),
  };
  void computerModule({ hub, chrome, caller: () => "c1", titleOf: (id) => (id === "c1" ? "Shopping" : id), settleMs: 0, sleep: async () => undefined }).activate(ctx);
  /** A paired Chrome, connected: the extension's hello, and its answers. */
  const pairChrome = (name = "Chrome on macOS"): FakeDevice => {
    const fake = new FakeDevice();
    fake.id = hub.pair({ code: hub.issueCode().code, name, platform: "chrome", publicKey: fake.publicKey }).device;
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: true, until: Date.now() + 15 * 60_000 } }));
    fake.answers.set("tabs.list", () => ({ ok: true, result: { tabs: [{ id: "77", url: "https://shop.example/cart", title: "Cart", handed: true }] } }));
    fake.answers.set("tabs.open", () => ({ ok: true, result: { tab: "88" } }));
    hub.accept(fake.socket);
    fake.hello({ app: { version: "0.1.0", platform: "chrome", os: "macOS" }, permissions: { tabs: true }, displays: [] });
    return fake;
  };
  return { hub, chrome, tools, risks, pairChrome };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("a Chrome paired through the extension", () => {
  it("connects with a browser's hello, and is answered when it pings", async () => {
    const { hub, pairChrome } = setup();
    const fake = pairChrome();
    expect(fake.welcome).toBeDefined();
    expect(hub.list()[0]).toMatchObject({ kind: "browser", online: true, permissions: { tabs: true } });
    const heard: string[] = [];
    const send = fake.socket.send;
    fake.socket.send = (text) => {
      heard.push(text);
      send(text);
    };
    fake.send({ t: "ping" });
    expect(heard).toContain('{"t":"pong"}');
    expect(fake.closed).toBeUndefined();
  });

  it("asks through KOS's approvals only when the owner's Chrome does not ask itself", () => {
    const { risks, pairChrome } = setup();
    const fake = pairChrome();
    const escalate = risks.get("chrome.start")!.escalate!;
    expect(escalate({ task: "t" })).toBe(false);
    fake.send({ t: "state", consent: "kos" });
    expect(escalate({ task: "t" })).toMatch(/without asking/);
  });

  it("is offered chrome.start, not the computer's tools, and computer.start sends a Chrome there", async () => {
    const { tools, pairChrome } = setup();
    pairChrome();
    expect([...tools.keys()].sort()).toEqual(["chrome.end", "chrome.page", "chrome.start"]);
  });

  it("asks the owner for a session in their Chrome, only when the owner started the work, and tells the chat what it was handed", async () => {
    const { hub, chrome, tools, pairChrome } = setup();
    const fake = pairChrome();
    await expect(attendance.run(false, () => tools.get("chrome.start")!({ task: "check the cart" }))).rejects.toThrow(/did not start/);
    const said = (await attendance.run(true, () => tools.get("chrome.start")!({ task: "check the cart" }))) as string;
    expect(fake.calls.find((c) => c.method === "session.begin")?.params).toMatchObject({ task: "check the cart", requester: "Shopping" });
    expect(said).toMatch(/^Working in the owner's Chrome \(Chrome on macOS\) for 1[45] minutes\. Your browser\.\* tools act there now, not in KOS's own browser/);
    expect(chrome.describe("c1")).toBe("the owner's Chrome (Chrome on macOS)");
    expect(said).toContain("Tabs the owner handed you: Cart");
    expect(hub.sessionOf("c1")?.target).toEqual({ kind: "tabs" });
    expect(chrome.active("c1")).toBe(true);
    expect(chrome.tabs("c1")).toEqual([{ id: "77", title: "Cart", url: "https://shop.example/cart" }]);
    expect(await tools.get("chrome.end")!({})).toMatch(/has their Chrome back/);
    expect(chrome.active("c1")).toBe(false);
  });

  it("drives a tab of its own through the extension, its page hearing the tab's events", async () => {
    const { chrome, tools, pairChrome } = setup();
    const fake = pairChrome();
    fake.answers.set("cdp.send", (p) => {
      if (p["method"] === "Page.navigate") {
        // The page's own events come back as the extension's.
        queueMicrotask(() => fake.event("cdp.event", { session: p["session"], tab: p["tab"], method: "Page.lifecycleEvent", params: { frameId: "F", loaderId: "L1", name: "DOMContentLoaded" } }));
        return { ok: true, result: { frameId: "F", loaderId: "L1" } };
      }
      if (p["method"] === "Page.getFrameTree") return { ok: true, result: { frameTree: { frame: { id: "F", loaderId: "L0" } } } };
      return { ok: true, result: {} };
    });
    await attendance.run(true, () => tools.get("chrome.start")!({ task: "look" }));
    const tab = await chrome.tab("c1");
    expect(fake.calls.filter((c) => c.method === "tabs.open")).toHaveLength(1);
    await tab.page.ready();
    expect(await tab.page.goto("https://shop.example/")).toEqual({ stillLoading: false });
    const sent = fake.calls.filter((c) => c.method === "cdp.send").map((c) => c.params);
    expect(sent.every((p) => p["tab"] === "88")).toBe(true);
    expect(sent.some((p) => p["method"] === "Page.navigate")).toBe(true);
    // A navigation it heard about moves the tab's address, and so its site.
    fake.event("cdp.event", { session: sent[0]!["session"], tab: "88", method: "Page.frameNavigated", params: { frame: { id: "F", url: "https://shop.example/checkout" } } });
    expect(chrome.siteOf("c1")).toBe("shop.example");
  });

  it("waits while the owner has taken over, and goes on when they hand it back", async () => {
    const { hub, chrome, tools, pairChrome } = setup();
    const fake = pairChrome();
    fake.answers.set("cdp.send", () => ({ ok: true, result: {} }));
    await attendance.run(true, () => tools.get("chrome.start")!({ task: "look" }));
    const session = hub.sessionOf("c1")!.id;
    const tab = await chrome.tab("c1");
    fake.event("session.paused", { session, reason: "owner" });
    let ran = false;
    const work = tab.page.run(async () => {
      ran = true;
      return tab.page.takeNotes();
    });
    await flush();
    expect(ran).toBe(false);
    fake.event("session.resumed", { session });
    expect(await work).toEqual([expect.stringMatching(/owner had this tab and has let go/)]);
  });

  it("follows the tabs the owner hands it and closes", async () => {
    const { hub, chrome, tools, pairChrome } = setup();
    const fake = pairChrome();
    await attendance.run(true, () => tools.get("chrome.start")!({ task: "look" }));
    fake.event("tab.handed", { tab: "99", url: "https://mail.example/", title: "Mail" });
    expect(chrome.tabsOf("c1")).toEqual(["77", "99"]);
    await chrome.useTab("c1", "99");
    expect(chrome.siteOf("c1")).toBe("mail.example");
    await expect(chrome.useTab("c1", "12345")).rejects.toThrow(/no such tab/);
    fake.event("tab.closed", { session: hub.sessionOf("c1")!.id, tab: "99" });
    expect(chrome.tabsOf("c1")).toEqual(["77"]);
  });

  it("works in the tab beside the side panel, and follows the owner to the next one they speak from", async () => {
    const { chrome, tools, pairChrome } = setup();
    const fake = pairChrome();
    fake.answers.set("tabs.list", () => ({ ok: true, result: { tabs: [{ id: "77", url: "https://shop.example/cart", title: "Cart", handed: true, focus: true }] } }));
    const said = (await attendance.run(true, () => tools.get("chrome.start")!({ task: "look" }))) as string;
    expect(said).toContain("in the tab the owner has open beside the side panel (Cart)");
    expect(chrome.tabs("c1")).toEqual([{ id: "77", title: "Cart", url: "https://shop.example/cart", current: true }]);
    await chrome.tab("c1");
    expect(fake.calls.some((c) => c.method === "tabs.open")).toBe(false);
    fake.event("tab.handed", { tab: "99", url: "https://mail.example/", title: "Mail", focus: true });
    expect(chrome.siteOf("c1")).toBe("mail.example");
  });

  it("takes a tab handed in one Chrome only into that Chrome's session", async () => {
    const { chrome, tools, pairChrome } = setup();
    pairChrome();
    const other = pairChrome("Chrome at work");
    await attendance.run(true, () => tools.get("chrome.start")!({ task: "look", chrome: "Chrome on macOS" }));
    other.event("tab.handed", { tab: "99", url: "https://mail.example/", title: "Mail", focus: true });
    expect(chrome.tabsOf("c1")).toEqual(["77"]);
  });
});

describe("a Chrome beside a computer", () => {
  it("offers both sets of tools, and keeps each to its own kind", async () => {
    const { hub, tools, pairChrome } = setup();
    pairChrome();
    const mac = new FakeDevice();
    mac.id = hub.pair({ code: hub.issueCode().code, name: "Studio MacBook", platform: "macos", publicKey: mac.publicKey }).device;
    hub.accept(mac.socket);
    mac.hello();
    expect([...tools.keys()].sort()).toEqual(["chrome.end", "chrome.page", "chrome.start", "computer.act", "computer.devices", "computer.end", "computer.start"]);
    await expect(attendance.run(true, () => tools.get("computer.start")!({ task: "x", device: "Chrome on macOS" }))).rejects.toThrow(/is the owner's Chrome, not a computer; chrome.start/);
    expect(await tools.get("computer.devices")!({})).toMatch(/Chrome on macOS \(dev_[^)]+\): the owner's own Chrome, through the KOS extension; chrome.start works in it \(it is not KOS's own browser\)/);
  });
});
