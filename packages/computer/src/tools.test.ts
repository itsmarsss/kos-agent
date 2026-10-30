import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { attendance, openDatabase, type ModuleContext, type ToolRisk } from "@kos/harness";

import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { DeviceStore } from "./store.js";
import { computerModule } from "./tools.js";

type Handler = (input: Record<string, unknown>) => unknown;
type Result = string | { text: string; images?: { mediaType: string; data: string }[] };

const hostPrivate = generateKeyPairSync("ed25519").privateKey;

function setup() {
  const hub = new DeviceHub({
    store: new DeviceStore(openDatabase(":memory:")),
    hostKey: { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) },
    halted: () => false,
    beginTimeoutMs: 200,
    callTimeoutMs: 200,
  });
  const tools = new Map<string, { handler: Handler; risk: ToolRisk | undefined }>();
  const halts: (() => void)[] = [];
  const ctx: ModuleContext = {
    registerTool: (def, handler, risk) => {
      tools.set(def.name, { handler: handler as Handler, risk });
    },
    unregisterTool: (name) => tools.delete(name),
  };
  const mod = computerModule({
    hub,
    caller: () => "c1",
    titleOf: (id) => (id === "c1" ? "Design" : id),
    onHalt: (handler) => {
      halts.push(handler);
      return () => undefined;
    },
    settleMs: 0,
    sleep: async () => undefined,
  });
  void mod.activate(ctx);
  const call = async (name: string, input: Record<string, unknown> = {}): Promise<Result> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return (await tool.handler(input)) as Result;
  };
  const pair = (name = "Studio MacBook"): FakeDevice => {
    const fake = new FakeDevice();
    fake.id = hub.pair({ code: hub.issueCode().code, name, platform: "macos", publicKey: fake.publicKey }).device;
    hub.accept(fake.socket);
    fake.hello();
    return fake;
  };
  return { hub, tools, call, pair, halts };
}

const textOf = (r: Result): string => (typeof r === "string" ? r : r.text);

describe("the computer tools", () => {
  it("are offered only while a computer is paired", () => {
    const { tools, pair, hub } = setup();
    expect(tools.size).toBe(0);
    const fake = pair();
    expect([...tools.keys()].sort()).toEqual(["computer.act", "computer.devices", "computer.end", "computer.start"]);
    hub.remove(fake.id);
    expect(tools.size).toBe(0);
  });

  it("ask through KOS's approvals only when the computer does not ask itself", () => {
    const { tools, pair } = setup();
    const fake = pair();
    const escalate = tools.get("computer.start")!.risk!.escalate!;
    expect(escalate({ task: "t" })).toBe(false);
    fake.send({ t: "state", consent: "kos" });
    expect(escalate({ task: "t" })).toMatch(/without asking/);
  });

  it("start a session the owner reads by the chat's title, and hand back the screen", async () => {
    const { call, pair } = setup();
    const fake = pair();
    const result = await call("computer.start", { task: "export the deck" });
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { task: "export the deck", requester: "Design", minutes: 15 } });
    expect(typeof result !== "string" && result.images?.[0]).toEqual({ mediaType: "image/jpeg", data: "SU1H" });
    expect(textOf(result)).toMatch(/Using Studio MacBook for 15 minutes.*1232x800.*Finder is in front/s);
  });

  it("turn each action into the device's call, then look", async () => {
    const { call, pair } = setup();
    const fake = pair();
    await call("computer.start", { task: "t" });
    const last = () => fake.calls.filter((c) => c.method !== "screen.capture").at(-1);

    const clicked = await call("computer.act", { action: "double_click", coordinate: [100, 200] });
    expect(last()).toMatchObject({ method: "pointer.click", params: { x: 100, y: 200, button: "left", count: 2 } });
    expect(textOf(clicked)).toMatch(/^Double-clicked at \(100, 200\)\. The screen/);
    expect(fake.calls.at(-1)?.method).toBe("screen.capture");

    await call("computer.act", { action: "left_click", coordinate: [1, 1], text: "cmd+shift" });
    expect(last()?.params).toMatchObject({ modifiers: ["cmd", "shift"] });
    await call("computer.act", { action: "scroll", coordinate: [50, 50], scroll_direction: "up", scroll_amount: 5 });
    expect(last()).toMatchObject({ method: "pointer.scroll", params: { x: 50, y: 50, dx: 0, dy: -5 } });
    await call("computer.act", { action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] });
    expect(last()).toMatchObject({ method: "pointer.drag", params: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } } });
    await call("computer.act", { action: "type", text: "hello" });
    expect(last()).toMatchObject({ method: "keys.type", params: { text: "hello" } });
    const before = fake.calls.length;
    const pressed = await call("computer.act", { action: "key", text: "cmd+s", then: "none" });
    expect(pressed).toBe("Pressed cmd+s.");
    expect(fake.calls.length).toBe(before + 1);
    await call("computer.act", { action: "zoom", region: [0, 0, 100, 50] });
    expect(fake.calls.at(-1)).toMatchObject({ method: "screen.capture", params: { region: { x: 0, y: 0, width: 100, height: 50 } } });
  });

  it("refuse what is off the screen, and say what to do when there is no session or the owner took over", async () => {
    const { call, pair } = setup();
    const fake = pair();
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/computer\.start first/);
    await call("computer.start", { task: "t" });
    await expect(call("computer.act", { action: "left_click", coordinate: [5000, 10] })).rejects.toThrow(/off the screen, which is 1232x800/);
    fake.answers.set("keys.type", () => ({ ok: false, code: "secure_input", message: "secure input" }));
    await expect(call("computer.act", { action: "type", text: "hunter2" })).rejects.toThrow(/password field has focus/);
    const session = (fake.calls[0]!.params.session as string);
    fake.event("session.paused", { session, reason: "owner" });
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/taken over.*Do not retry/);
    fake.event("session.ended", { session, reason: "owner" });
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/the owner stopped it/);
  });

  it("ask for the owner's default length, and refuse work the owner did not start unless allowed", async () => {
    const { call, pair, hub } = setup();
    const fake = pair();
    hub.updateSettings({ askMinutes: 45 });
    await attendance.run(false, async () => {
      await expect(call("computer.start", { task: "nightly check" })).rejects.toThrow(/did not start.*Settings, Devices/);
    });
    expect(fake.calls).toEqual([]);
    hub.updateSettings({ unattended: true });
    await attendance.run(false, () => call("computer.start", { task: "nightly check" }));
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { minutes: 45 } });
  });

  it("tell the agent what is paired, and end at the kill switch", async () => {
    const { call, pair, halts, hub } = setup();
    pair();
    await call("computer.start", { task: "t" });
    expect(await call("computer.devices")).toMatch(/Studio MacBook \(dev_[^)]+, macos\): online, asks on the computer, in use by Design/);
    halts.forEach((h) => h());
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(await call("computer.end")).toBe("There was no session to end.");
  });
});
