import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { attendance, openDatabase, origin, ownership, turnStop, type ModuleContext, type ToolRisk } from "@kos/harness";

import { FakeDevice } from "./device.fixture.js";
import { OwnerChrome } from "./chrome.js";
import { DeviceHub } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { DeviceStore } from "./store.js";
import { computerModule } from "./tools.js";

type Handler = (input: Record<string, unknown>) => unknown;
type ToolSpec = Parameters<ModuleContext["registerTool"]>[0];
type Result = string | { text: string; images?: { mediaType: string; data: string }[] };

const hostPrivate = generateKeyPairSync("ed25519").privateKey;

/** The owner speaking on a surface: what a call in that turn is under. */
type Spoken = { surface: string; said: string };

function setup(opts: { settleMs?: number; sleep?: (ms: number) => Promise<void>; mac?: () => { device: string; app?: string } | undefined; from?: Spoken } = {}) {
  const hub = new DeviceHub({
    store: new DeviceStore(openDatabase(":memory:")),
    hostKey: { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) },
    halted: () => false,
    beginTimeoutMs: 200,
    callTimeoutMs: 200,
  });
  const tools = new Map<string, { spec: ToolSpec; handler: Handler; risk: ToolRisk | undefined }>();
  const halts: (() => void)[] = [];
  const stops: ((chat: string) => void)[] = [];
  const freshes: ((chat: string) => void)[] = [];
  const ends: ((chat: string) => void)[] = [];
  const ctx: ModuleContext = {
    registerTool: (def, handler, risk) => {
      tools.set(def.name, { spec: def, handler: handler as Handler, risk });
    },
    unregisterTool: (name) => tools.delete(name),
  };
  const mod = computerModule({
    hub,
    chrome: new OwnerChrome(hub),
    caller: () => "c1",
    titleOf: (id) => (id === "c1" ? "Design" : id),
    onHalt: (handler) => {
      halts.push(handler);
      return () => undefined;
    },
    onStop: (handler) => {
      stops.push(handler);
      return () => undefined;
    },
    onFresh: (handler) => {
      freshes.push(handler);
      return () => undefined;
    },
    onTurnEnd: (handler) => {
      ends.push(handler);
      return () => undefined;
    },
    ...(opts.mac ? { panelMac: () => opts.mac!() } : {}),
    settleMs: opts.settleMs ?? 0,
    sleep: opts.sleep ?? (async () => undefined),
  });
  void mod.activate(ctx);
  const call = async (name: string, input: Record<string, unknown> = {}): Promise<Result> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    const run = async (): Promise<Result> => (await tool.handler(input)) as Result;
    return (await (opts.from ? ownership.run(true, () => origin.run(opts.from!, run)) : run())) as Result;
  };
  const pair = (name = "Studio MacBook"): FakeDevice => {
    const fake = new FakeDevice();
    fake.id = hub.pair({ code: hub.issueCode().code, name, platform: "macos", publicKey: fake.publicKey }).device;
    hub.accept(fake.socket);
    fake.hello();
    return fake;
  };
  return { hub, tools, call, pair, halts, module: mod, stop: (chat: string) => stops.forEach((s) => s(chat)), fresh: (chat: string) => freshes.forEach((f) => f(chat)), endTurn: (chat: string) => ends.forEach((e) => e(chat)) };
}

const textOf = (r: Result): string => (typeof r === "string" ? r : r.text);

describe("the computer tools", () => {
  it("are offered only while a computer is paired", () => {
    const { tools, pair, hub } = setup();
    expect(tools.size).toBe(0);
    const fake = pair();
    expect([...tools.keys()].sort()).toEqual(["computer.act", "computer.end", "computer.start"]);
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
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { task: "export the deck", requester: "Design", minutes: 15, maxEdge: 1024 } });
    expect(typeof result !== "string" && result.images?.[0]).toEqual({ mediaType: "image/jpeg", data: "SU1H" });
    expect(textOf(result)).toMatch(/Using Studio MacBook until this turn ends\..*1232x800.*Finder is in front/s);
  });

  it("offer the app KOS names, and say when only its window was shared", async () => {
    const { call, pair } = setup();
    const fake = pair();
    fake.answers.set("session.begin", () => ({
      ok: true,
      result: { granted: true, until: Date.now() + 15 * 60_000, space: { width: 900, height: 600 }, target: { kind: "window", app: "Figma", title: "Cover" } },
    }));
    const result = await call("computer.start", { task: "export the cover", app: "Figma" });
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { target: { app: "Figma" } } });
    expect(textOf(result)).toMatch(/the Figma window "Cover" on Studio MacBook, and only it/);
    const session = fake.calls[0]!.params.session as string;
    fake.event("session.ended", { session, reason: "window" });
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/the window it was given closed/);
  });

  it("turn each action into the device's call, then look", async () => {
    const { call, pair } = setup();
    const fake = pair();
    await call("computer.start", { task: "t" });
    const last = () => fake.calls.filter((c) => c.method !== "screen.capture").at(-1);

    const clicked = await call("computer.act", { action: "double_click", coordinate: [100, 200] });
    expect(last()).toMatchObject({ method: "pointer.click", params: { x: 100, y: 200, button: "left", count: 2 } });
    expect(textOf(clicked)).toMatch(/^Done: Double-clicked at \(100, 200\)\. The screen/);
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
    expect(pressed).toBe("Done: Pressed cmd+s.");
    expect(fake.calls.length).toBe(before + 1);
    await call("computer.act", { action: "zoom", region: [0, 0, 100, 50] });
    expect(fake.calls.at(-1)).toMatchObject({ method: "screen.capture", params: { region: { x: 0, y: 0, width: 100, height: 50 } } });
  });

  it("do a run of actions in one call, with one picture at the end, stopping at the first that fails", async () => {
    const { call, pair } = setup();
    const fake = pair();
    await call("computer.start", { task: "t" });
    const before = fake.calls.length;
    const ran = await call("computer.act", {
      actions: [
        { action: "left_click", coordinate: [10, 20] },
        { action: "type", text: "milk" },
        { action: "key", text: "Return" },
      ],
    });
    expect(fake.calls.slice(before).map((c) => c.method)).toEqual(["pointer.click", "keys.type", "keys.press", "screen.capture"]);
    expect(textOf(ran)).toMatch(/^Done: Clicked at \(10, 20\); Typed 4 characters; Pressed Return\. The screen/);
    await expect(call("computer.act", { actions: [{ action: "type", text: "a" }, { action: "left_click" }] })).rejects.toThrow(/^Done: Typed 1 character\. Step 2 \(left_click\) failed: left_click needs a coordinate/);
    await expect(call("computer.act", { actions: [{ action: "zoom" }] })).rejects.toThrow(/step 1: each is one of/);
    // A screenshot inside a run is the run's one picture, even when the run would not look.
    const shown = fake.calls.length;
    const looked = await call("computer.act", { then: "none", actions: [{ action: "key", text: "Tab" }, { action: "screenshot" }] });
    expect(fake.calls.slice(shown).map((c) => c.method)).toEqual(["keys.press", "screen.capture"]);
    expect(textOf(looked)).toMatch(/^Done: Pressed Tab\. The screen/);
  });

  it("take an intent the owner reads as the step, for one action or a run", async () => {
    const { tools, call, pair } = setup();
    const fake = pair();
    const act = tools.get("computer.act")!;
    const schema = act.spec.inputSchema as { properties: Record<string, { type: string }>; required?: string[] };
    expect(schema.properties.intent).toMatchObject({ type: "string" });
    expect(schema.required ?? []).not.toContain("intent");
    expect(act.spec.description).toMatch(/`intent`/);
    await call("computer.start", { task: "t" });
    await call("computer.act", { intent: "open the Quizzes tab", action: "left_click", coordinate: [10, 20] });
    await call("computer.act", { intent: "search for it", actions: [{ action: "type", text: "milk" }, { action: "key", text: "Return" }] });
    expect(fake.calls.map((c) => c.method)).toContain("keys.press");
  });

  it("let a computer that settles its own pictures do so, and keep the fixed wait for one that does not", async () => {
    const slept: number[] = [];
    const { call, pair } = setup({ settleMs: 450, sleep: async (ms) => void slept.push(ms) });
    const fake = pair();
    let settles = false;
    let n = 0;
    fake.answers.set("screen.capture", (params) => ({
      ok: true,
      result: { image: `SU1H${n++}`, mediaType: "image/jpeg", width: 1232, height: 800, cursor: { x: 0, y: 0 }, ...(settles && params.settle ? { settled: true } : {}) },
    }));
    await call("computer.start", { task: "t" });
    // An older computer: the fixed wait, and asked to settle in case it can.
    await call("computer.act", { action: "left_click", coordinate: [10, 10] });
    expect(slept).toEqual([450]);
    expect(fake.calls.at(-1)).toMatchObject({ method: "screen.capture", params: { settle: 450 } });
    settles = true;
    await call("computer.act", { action: "left_click", coordinate: [10, 10] });
    // It said it settles: no more waiting on this side.
    await call("computer.act", { actions: [{ action: "key", text: "Tab" }, { action: "key", text: "Tab" }] });
    expect(slept.filter((ms) => ms === 450)).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === "screen.capture").at(-1)?.params).toMatchObject({ settle: 450 });
  });

  it("say in words that a screen has not changed rather than send the same picture again, and wait up to a minute", async () => {
    const { call, pair } = setup();
    const fake = pair();
    const first = await call("computer.start", { task: "watch the build" });
    expect(typeof first).not.toBe("string");
    const same = await call("computer.act", { action: "wait", duration: 90 });
    expect(same).toBe("Done: Waited 60s (one call waits at most 60s in all). The screen has not changed since your last picture.");
    fake.answers.set("screen.capture", () => ({ ok: true, result: { image: "Q0hBTkdFRA", mediaType: "image/jpeg", width: 1232, height: 800, cursor: { x: 10, y: 20 }, app: { name: "Terminal", bundle: "com.apple.Terminal" } } }));
    const changed = await call("computer.act", { action: "screenshot" });
    expect(typeof changed === "string" ? [] : changed.images).toHaveLength(1);
    // A zoom is always a picture, and a session started again starts with one.
    await call("computer.end");
    expect(typeof (await call("computer.start", { task: "again" }))).not.toBe("string");
  });

  it("send the picture whenever a screenshot is asked for, and after a new turn or query", async () => {
    const { call, pair, fresh } = setup();
    pair();
    await call("computer.start", { task: "watch" });
    const pictured = (r: Result): boolean => typeof r !== "string" && (r.images?.length ?? 0) === 1;
    // Asked for outright: the picture, though nothing changed.
    expect(pictured(await call("computer.act", { action: "screenshot" }))).toBe(true);
    expect(await call("computer.act", { action: "key", text: "Tab" })).toBe("Done: Pressed Tab. The screen has not changed since your last picture.");
    // A new turn, or a turn carried on in a fresh query, has not seen it: sent whole.
    fresh("c1");
    expect(pictured(await call("computer.act", { action: "key", text: "Tab" }))).toBe(true);
    expect(textOf(await call("computer.act", { action: "key", text: "Tab" }))).toMatch(/has not changed/);
    fresh("other");
    expect(textOf(await call("computer.act", { action: "key", text: "Tab" }))).toMatch(/has not changed/);
    fresh("c1");
    expect(pictured(await call("computer.act", { action: "key", text: "Tab" }))).toBe(true);
  });

  it("wait at most a minute a call, keeping the session alive meanwhile", async () => {
    const slept: number[] = [];
    const { call, pair } = setup({ sleep: async (ms) => void slept.push(ms) });
    const fake = pair();
    await call("computer.start", { task: "watch the build" });
    const before = fake.calls.length;
    const said = textOf(await call("computer.act", { then: "none", actions: [{ action: "wait", duration: 50 }, { action: "wait", duration: 50 }, { action: "wait", duration: 50 }] }));
    expect(said).toBe("Done: Waited 50s; Waited 10s (one call waits at most 60s in all); Waited 0s (one call waits at most 60s in all).");
    expect(slept.filter((ms) => ms !== 120).reduce((a, b) => a + b, 0)).toBe(60_000);
    // A look at one pixel between the slices of a long wait: the device counts it as use.
    const touches = fake.calls.slice(before).filter((c) => c.method === "screen.capture");
    expect(touches.length).toBeGreaterThan(0);
    expect(touches.every((c) => (c.params.region as { width: number }).width === 1)).toBe(true);
  });

  it("take no further action in a run once the turn is stopped, nor wait", async () => {
    const stop = new AbortController();
    // The pause between actions is where Stop lands.
    const { call, pair } = setup({ sleep: async () => stop.abort() });
    const fake = pair();
    await call("computer.start", { task: "t" });
    const before = fake.calls.length;
    const ran = turnStop.run(stop.signal, () =>
      call("computer.act", { actions: [{ action: "left_click", coordinate: [10, 20] }, { action: "type", text: "milk" }, { action: "key", text: "Return" }] }),
    );
    await expect(ran).rejects.toThrow(/^Done: Clicked at \(10, 20\)\. Stopped by the owner before step 2\.$/);
    expect(fake.calls.slice(before).map((c) => c.method)).toEqual(["pointer.click"]);
    // A wait under a turn already stopped ends at once.
    const never = setup({ sleep: () => new Promise<void>(() => undefined) });
    never.pair();
    await never.call("computer.start", { task: "t" });
    await expect(turnStop.run(stop.signal, () => never.call("computer.act", { action: "wait", duration: 60 }))).rejects.toThrow(/Stopped by the owner before step 1/);
  });

  it("start nothing when Stop lands while the owner is asked, and give back a yes given after it", async () => {
    const stop = new AbortController();
    const { call, pair, hub } = setup();
    const fake = pair();
    fake.answers.delete("session.begin");
    const asked = turnStop.run(stop.signal, () => call("computer.start", { task: "t" }));
    await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    await expect(asked).rejects.toThrow(/none was started/);
    // The owner presses Allow on the device afterwards.
    fake.answer("session.begin", { granted: true, until: Date.now() + 60_000, space: { width: 100, height: 100 } });
    await new Promise((r) => setTimeout(r, 5));
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(fake.calls.at(-1)?.method).toBe("session.end");
  });

  it("give back a session the owner allows once the turn that asked has ended", async () => {
    const { call, pair, hub, endTurn } = setup();
    const fake = pair();
    fake.answers.delete("session.begin");
    const asked = call("computer.start", { task: "t" });
    await new Promise((r) => setTimeout(r, 5));
    endTurn("c1");
    fake.answer("session.begin", { granted: true, until: Date.now() + 60_000, space: { width: 100, height: 100 } });
    await expect(asked).rejects.toThrow(/none was started/);
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(fake.calls.map((c) => c.method)).toContain("session.end");
  });

  it("claim no more than that a device call Stop answered may have finished", async () => {
    const stop = new AbortController();
    const { call, pair } = setup();
    const fake = pair();
    await call("computer.start", { task: "t" });
    // A click the device never answers: Stop is all that ends the wait on it.
    fake.answers.delete("pointer.click");
    const ran = turnStop.run(stop.signal, () => call("computer.act", { action: "left_click", coordinate: [10, 20] }));
    await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    await expect(ran).rejects.toThrow(/^Stopped by the owner; step 1 may have finished on the device\.$/);
  });

  it("end a wait at once on Stop, the kill switch or the session ending", async () => {
    // A sleep that never ends on its own: only an interruption ends the wait.
    const { call, pair, stop, halts, hub } = setup({ sleep: () => new Promise<void>(() => undefined) });
    const fake = pair();
    await call("computer.start", { task: "t" });
    const stopped = call("computer.act", { action: "wait", duration: 60 });
    await Promise.resolve();
    stop("other");
    stop("c1");
    await expect(stopped).rejects.toThrow(/pressed Stop/);

    const halted = call("computer.act", { action: "wait", duration: 60 });
    await Promise.resolve();
    for (const h of halts) h();
    await expect(halted).rejects.toThrow(/No session.*computer\.start first/);

    await call("computer.start", { task: "again" });
    const ended = call("computer.act", { action: "wait", duration: 60 });
    await Promise.resolve();
    const session = fake.calls.filter((c) => c.method === "session.begin").at(-1)!.params.session as string;
    fake.event("session.ended", { session, reason: "idle" });
    await expect(ended).rejects.toThrow(/it sat idle/);
    expect(hub.sessionOf("c1")).toBeUndefined();
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

  it("pick the one computer there is, say what is paired when more than one could be meant, and end at the kill switch", async () => {
    const { call, pair, halts, hub } = setup();
    pair();
    pair("Office iMac");
    await expect(call("computer.start", { task: "t" })).rejects.toThrow(/More than one computer could be meant.*Paired:\nStudio MacBook \(dev_[^)]+\): online, asks on the device, free\nOffice iMac/s);
    await call("computer.start", { task: "t", device: "Studio" });
    expect(hub.sessionOf("c1")).toBeDefined();
    halts.forEach((h) => h());
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(await call("computer.end")).toBe("There was no session to end.");
  });

  it("keep a session the owner's own turn started past it, for the chat, until its time, an end, the owner leaving or the kill switch", async () => {
    const { call, pair, hub, endTurn, tools, halts, module } = setup();
    const fake = pair();
    const mod = () => ownership.run(true, () => call("computer.start", { task: "watch the export" }));
    expect(textOf(await mod())).toMatch(/for 15 minutes, past this turn, until computer\.end/);
    endTurn("c1");
    expect(hub.sessionOf("c1")).toBeDefined();
    // A call the owner approved after the turn, run outside any turn, still finds it.
    await call("computer.act", { action: "left_click", coordinate: [10, 20] });
    expect(fake.calls.map((c) => c.method)).toContain("pointer.click");
    // Its time.
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: true, until: Date.now() + 30, space: { width: 1232, height: 800 } } }));
    await call("computer.end");
    await mod();
    await new Promise((r) => setTimeout(r, 40));
    expect(hub.sessionOf("c1")).toBeUndefined();
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: true, until: Date.now() + 60_000, space: { width: 1232, height: 800 } } }));
    // The owner leaving the chat on the device; a Chrome's panel never ends a computer's session.
    await mod();
    module.left("c1", "browser");
    expect(hub.sessionOf("c1")).toBeDefined();
    module.left("c1", "computer");
    expect(hub.sessionOf("c1")).toBeUndefined();
    // The kill switch.
    await mod();
    halts.forEach((h) => h());
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(tools.size).toBeGreaterThan(0);
  });

  it("end a session with the turn that started it, unless it was kept", async () => {
    const { call, pair, hub, endTurn } = setup();
    const fake = pair();
    await call("computer.start", { task: "t" });
    endTurn("other");
    expect(hub.sessionOf("c1")).toBeDefined();
    endTurn("c1");
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(fake.calls.at(-1)?.method).toBe("session.end");
    const kept = await call("computer.start", { task: "watch the export", keep: true });
    expect(textOf(kept)).toMatch(/past this turn, until computer\.end/);
    endTurn("c1");
    expect(hub.sessionOf("c1")).toBeDefined();
    await call("computer.end");
    await call("computer.start", { task: "again" });
    endTurn("c1");
    expect(hub.sessionOf("c1")).toBeUndefined();
  });
});

describe("a turn from the KOS for Mac window", () => {
  it("starts its session on that Mac with its first act, offering the app in front, and does nothing it has not seen", async () => {
    const at: { mac?: { device: string; app?: string } } = {};
    const { call, pair, hub } = setup({ mac: () => at.mac, from: { surface: "mac", said: "export this deck" } });
    const fake = pair();
    at.mac = { device: fake.id, app: "Keynote" };
    const first = await call("computer.act", { action: "left_click", coordinate: [10, 20] });
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { task: '"export this deck"', target: { app: "Keynote" }, maxEdge: 1024 } });
    expect(fake.calls.map((c) => c.method)).not.toContain("pointer.click");
    expect(typeof first !== "string" && first.images).toHaveLength(1);
    expect(textOf(first)).toMatch(/past this turn, until computer\.end.*Nothing else was done: you had not seen this screen/s);
    // From then on, the session is there: the act runs.
    await call("computer.act", { intent: "open the File menu", action: "left_click", coordinate: [10, 20] });
    expect(fake.calls.map((c) => c.method)).toContain("pointer.click");
    expect(hub.sessionOf("c1")).toBeDefined();
  });

  it("says the intent as the task, answers a first screenshot with the screen alone, and starts nothing outside the window's chat", async () => {
    const at: { mac?: { device: string; app?: string } } = {};
    const { call, pair } = setup({ mac: () => at.mac, from: { surface: "mac", said: "what is open?" } });
    const fake = pair();
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/computer\.start first/);
    expect(fake.calls).toEqual([]);
    at.mac = { device: fake.id };
    const seen = await call("computer.act", { intent: "see what is open", action: "screenshot" });
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { task: "see what is open" } });
    expect(textOf(seen)).not.toMatch(/Nothing else was done/);
  });

  it("asks once a turn: after the owner says no, a later act is refused in the same words until the turn ends", async () => {
    const { call, pair, endTurn } = setup({ mac: () => ({ device: fake.id }), from: { surface: "mac", said: "look" } });
    const fake = pair();
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: false } }));
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/did not allow the session/);
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/did not allow the session.*Do not ask again/);
    expect(fake.calls.filter((c) => c.method === "session.begin")).toHaveLength(1);
    endTurn("c1");
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/did not allow/);
    expect(fake.calls.filter((c) => c.method === "session.begin")).toHaveLength(2);
  });

  it("starts nothing for a turn in the window's chat that is not the owner speaking there", async () => {
    for (const from of [undefined, { surface: "dashboard", said: "look at my screen" }, { surface: "dispatch", said: "look at my screen" }]) {
      const { call, pair } = setup({ mac: () => ({ device: fake.id }), ...(from ? { from } : {}) });
      const fake = pair();
      await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/not the owner speaking in the KOS for Mac window.*computer\.start/);
      expect(fake.calls).toEqual([]);
    }
  });

  it("keeps the consent it needs: a Mac that leaves sessions to KOS's approvals, or work the owner did not start, is refused", async () => {
    const at: { mac?: { device: string; app?: string } } = {};
    const { call, pair } = setup({ mac: () => at.mac, from: { surface: "mac", said: "look" } });
    const fake = pair();
    at.mac = { device: fake.id };
    await expect(attendance.run(false, () => call("computer.act", { action: "screenshot" }))).rejects.toThrow(/did not start/);
    fake.send({ t: "state", consent: "kos" });
    await expect(call("computer.act", { action: "screenshot" })).rejects.toThrow(/through KOS's approvals.*computer\.start first/);
    expect(fake.calls).toEqual([]);
  });
});
