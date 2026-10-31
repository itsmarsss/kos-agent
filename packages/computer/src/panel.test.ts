import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { attendance, openDatabase, type ChatEvent, type InboundMessage, type ModuleContext } from "@kos/harness";

import { OwnerChrome } from "./chrome.js";
import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { ChromePanel, panelLines } from "./panel.js";
import { DeviceStore } from "./store.js";
import { computerModule } from "./tools.js";

/**
 * The side panel of a paired Chrome as a surface: the owner's words come in
 * over the Chrome's line, the chat goes back as it stands, approvals are
 * decided in place, and chrome.page reads the page beside the panel for the
 * panel's chat and no other.
 */

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
type Handler = (input: Record<string, unknown>) => unknown;

function setup(opts: { halted?: boolean } = {}) {
  const hub = new DeviceHub({
    store: new DeviceStore(openDatabase(":memory:")),
    hostKey: { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) },
    halted: () => opts.halted ?? false,
    callTimeoutMs: 500,
  });
  let chat: { id: string; title: string } | undefined;
  let events: ChatEvent[] = [];
  const panel = new ChromePanel({ current: () => chat, events: () => events });
  panel.attach(hub);
  let caller = "chrome:owner";
  const tools = new Map<string, Handler>();
  const ctx: ModuleContext = {
    registerTool: (def, handler) => void tools.set(def.name, handler as Handler),
    unregisterTool: (name) => tools.delete(name),
  };
  void computerModule({ hub, chrome: new OwnerChrome(hub), caller: () => caller, titleOf: () => "Chrome", panelChrome: (c) => panel.chromeOf(c) }).activate(ctx);
  const pair = (platform = "chrome"): FakeDevice => {
    const fake = new FakeDevice();
    fake.id = hub.pair({ code: hub.issueCode().code, name: platform === "chrome" ? "Chrome on macOS" : "Studio MacBook", platform, publicKey: fake.publicKey }).device;
    for (const m of ["chat.show", "chat.status", "chat.ask", "chat.settled"]) fake.answers.set(m, () => ({ ok: true, result: {} }));
    hub.accept(fake.socket);
    if (platform === "chrome") fake.hello({ app: { version: "0.1.0", platform: "chrome", os: "macOS" }, permissions: { tabs: true }, displays: [] });
    else fake.hello();
    return fake;
  };
  return {
    hub,
    panel,
    tools,
    pair,
    setChat: (c: typeof chat, e: ChatEvent[] = []) => {
      chat = c;
      events = e;
    },
    callFrom: (c: string) => {
      caller = c;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("the panel's chat as it draws it", () => {
  it("keeps the words and notes, folds tool calls into steps, and leaves reasoning out", () => {
    const events: ChatEvent[] = [
      { kind: "message", role: "you", text: "what is this page", attachments: [{ name: "receipt.png" }] },
      { kind: "reasoning", text: "thinking" },
      { kind: "tool", name: "chrome.page", summary: "Read the page", args: {} },
      { kind: "tool", name: "browser.click", summary: "Clicked Buy", args: {}, isError: true },
      { kind: "message", role: "kos", text: "A shop." },
      { kind: "message", role: "system", text: "Approved #4 · chrome.start ran" },
      { kind: "divider", text: "Cleared", at: 1 },
    ];
    expect(panelLines(events)).toEqual([
      { role: "you", text: "what is this page", files: ["receipt.png"] },
      { role: "steps", steps: [{ summary: "Read the page" }, { summary: "Clicked Buy", failed: true }] },
      { role: "kos", text: "A shop." },
      { role: "note", text: "Approved #4 · chrome.start ran" },
      { role: "note", text: "Cleared" },
    ]);
    expect(panelLines(events, 2)).toHaveLength(2);
  });
});

describe("a Chrome's side panel", () => {
  it("takes the owner's words from a paired Chrome only, as the owner", async () => {
    const { panel, pair } = setup();
    const chrome = pair();
    const mac = pair("macos");
    const heard: InboundMessage[] = [];
    panel.onMessage((m) => void heard.push(m));
    chrome.event("chat.send", { text: "  what is this?  " });
    mac.event("chat.send", { text: "not a Chrome" });
    chrome.event("chat.send", { text: "   " });
    await flush();
    expect(heard).toEqual([{ channel: "chrome", senderId: chrome.id, text: "what is this?" }]);
    const identity = panel.identity("owner");
    expect(identity.resolve("chrome", chrome.id)).toBe("owner");
    expect(identity.resolve("chrome", mac.id)).toBeNull();
    expect(identity.resolve("discord", chrome.id)).toBeNull();
  });

  it("shows the chat when the panel opens, and after a turn with what was answered outside it", async () => {
    const { panel, pair, setChat } = setup();
    const chrome = pair();
    setChat({ id: "chrome:owner", title: "Chrome" }, [
      { kind: "message", role: "you", text: "hi" },
      { kind: "message", role: "kos", text: "Hello." },
    ]);
    chrome.event("chat.open", {});
    await flush();
    expect(chrome.calls.at(-1)).toEqual({
      method: "chat.show",
      params: { conversation: "chrome:owner", title: "Chrome", messages: [{ role: "you", text: "hi" }, { role: "kos", text: "Hello." }] },
    });
    const presence = await panel.acknowledge({ channel: "chrome", senderId: chrome.id, text: "/new" });
    await presence.update("› Read the page");
    expect(chrome.calls.at(-1)).toEqual({ method: "chat.status", params: { story: "› Read the page" } });
    await presence.complete({ text: "Hello." });
    expect(chrome.calls.at(-1)?.params["notice"]).toBeUndefined();
    await presence.complete({ text: "Started a new chat.", from: { name: "recap" } });
    expect(chrome.calls.at(-1)?.params["notice"]).toEqual({ text: "Started a new chat.", from: "recap" });
    await presence.fail("KOS hit an error.");
    expect(chrome.calls.at(-1)).toEqual({ method: "chat.status", params: { story: null, error: "KOS hit an error." } });
  });

  it("asks in the panel only for the panel's chat, and takes the decision back", async () => {
    const { panel, pair, setChat } = setup();
    const chrome = pair();
    setChat({ id: "chrome:owner", title: "Chrome" });
    await panel.requestApproval("owner", { id: "9", text: "Approve x?", tool: "files.delete", args: { path: "a" }, asker: { name: "Budget", conversationId: "project:budget" } });
    expect(chrome.calls.some((c) => c.method === "chat.ask")).toBe(false);
    await panel.requestApproval("owner", { id: "10", text: "Approve x?", tool: "files.delete", args: { path: "a" }, why: "Clearing it.", asker: { name: "Chrome", conversationId: "chrome:owner" } });
    expect(chrome.calls.at(-1)).toEqual({ method: "chat.ask", params: { approval: { id: "10", tool: "files.delete", args: '{"path":"a"}', why: "Clearing it." } } });
    const decided: unknown[] = [];
    panel.onApproval((d) => void decided.push(d));
    chrome.event("chat.decide", { approval: "10", approved: true });
    await flush();
    expect(decided).toEqual([{ id: "10", approved: true, deciderId: chrome.id }]);
    await panel.settleApproval("10", "approved");
    expect(chrome.calls.at(-1)).toEqual({ method: "chat.settled", params: { approval: "10", outcome: "approved" } });
  });

  it("reads the page beside the panel for the panel's chat, and for no other", async () => {
    const { panel, tools, pair, setChat, callFrom } = setup();
    const chrome = pair();
    chrome.answers.set("page.read", (p) => ({ ok: true, result: { url: "https://shop.example/", title: "Shop", selection: "Blue mug", text: `asked for ${String(p["conversation"])}` } }));
    setChat({ id: "chrome:owner", title: "Chrome" });
    await expect(tools.get("chrome.page")!({})).rejects.toThrow(/not the owner's Chrome side panel/);
    chrome.event("chat.send", { text: "what is this" });
    await flush();
    expect(panel.chromeOf("chrome:owner")).toBe(chrome.id);
    expect(await tools.get("chrome.page")!({})).toBe("Shop\nhttps://shop.example/\n\nThe owner selected:\nBlue mug\n\nasked for chrome:owner");
    callFrom("project:budget");
    await expect(tools.get("chrome.page")!({})).rejects.toThrow(/not the owner's Chrome side panel/);
  });

  it("starts a session in the Chrome the owner is talking from", async () => {
    const { tools, pair, setChat } = setup();
    pair();
    const chrome = pair();
    chrome.answers.set("session.begin", () => ({ ok: true, result: { granted: true, until: Date.now() + 15 * 60_000 } }));
    chrome.answers.set("tabs.list", () => ({ ok: true, result: { tabs: [] } }));
    setChat({ id: "chrome:owner", title: "Chrome" });
    chrome.event("chat.send", { text: "buy it" });
    await flush();
    await attendance.run(true, () => tools.get("chrome.start")!({ task: "buy the mug" }));
    expect(chrome.calls.some((c) => c.method === "session.begin")).toBe(true);
  });

  it("reads no page under the kill switch", async () => {
    const { hub, pair } = setup({ halted: true });
    const chrome = pair();
    await expect(hub.request(chrome.id, "page.read", {})).rejects.toThrow(/halted/);
    await expect(hub.request(chrome.id, "chat.show", {})).resolves.toEqual({});
  });
});
