import { generateKeyPairSync } from "node:crypto";

import { openDatabase } from "@kos/harness";
import { drawingOf, lookOf, type FaceDrawing } from "@kos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDevice } from "./device.fixture.js";
import { DeviceHub, PairError } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { DeviceError, REFUSED_REASON } from "./link.js";
import { PairingCodes } from "./pairing.js";
import { CLOSE } from "./protocol.js";
import { DeviceStore } from "./store.js";

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };

function setup(over: { halted?: () => boolean; face?: () => FaceDrawing; handBackWaitMs?: number } = {}) {
  const store = new DeviceStore(openDatabase(":memory:"));
  const hub = new DeviceHub({ store, hostKey, halted: over.halted ?? (() => false), log: () => undefined, beginTimeoutMs: 200, callTimeoutMs: 200, ...(over.face ? { face: over.face } : {}), ...(over.handBackWaitMs ? { handBackWaitMs: over.handBackWaitMs } : {}) });
  return { store, hub };
}

/** A device paired through a real code, connected, and through the handshake. */
async function online(hub: DeviceHub, name = "Studio MacBook"): Promise<FakeDevice> {
  const fake = new FakeDevice();
  const { code } = hub.issueCode();
  fake.id = hub.pair({ code, name, platform: "macos", publicKey: fake.publicKey }).device;
  hub.accept(fake.socket);
  fake.hello();
  await Promise.resolve();
  return fake;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("KOS's face on a device", () => {
  it("is sent once the device is in, and again to every device online when the owner changes it", async () => {
    let face = drawingOf(lookOf("kos"));
    const { hub } = setup({ face: () => face });
    const fake = new FakeDevice();
    const { code } = hub.issueCode();
    fake.id = hub.pair({ code, name: "Studio MacBook", platform: "macos", publicKey: fake.publicKey }).device;
    hub.accept(fake.socket);
    // Nothing before the handshake: an unproved line is told nothing.
    expect(fake.faces).toEqual([]);
    fake.hello();
    await Promise.resolve();
    expect(fake.faces).toEqual([face]);
    const other = await online(hub, "Work Chrome");
    face = drawingOf(lookOf("kos", { shape: "mochi", colour: "#8b5cf6" }));
    hub.tellFace();
    expect(fake.faces.at(-1)).toEqual(face);
    expect(other.faces.at(-1)).toMatchObject({ fill: "#8b5cf6", shape: { lobes: face.shape.lobes } });
  });
});

describe("pairing a device", () => {
  it("takes a live code once, with the device's key, and hands back KOS's key", () => {
    const { hub, store } = setup();
    const fake = new FakeDevice();
    const { code } = hub.issueCode();
    const paired = hub.pair({ code, name: "  Studio\nMacBook ", platform: "macos", publicKey: fake.publicKey });
    expect(paired.hostKey).toBe(hostKey.publicKey);
    expect(store.get(paired.device)?.name).toBe("Studio MacBook");
    expect(() => hub.pair({ code, name: "Again", platform: "macos", publicKey: new FakeDevice().publicKey })).toThrow(PairError);
  });

  it("refuses a wrong code, a key that is not a key, and a key already paired", () => {
    const { hub } = setup();
    const fake = new FakeDevice();
    const status = (fn: () => unknown): number | undefined => {
      try {
        fn();
      } catch (err) {
        return err instanceof PairError ? err.status : -1;
      }
      return undefined;
    };
    expect(status(() => hub.pair({ code: "AAAA-AAAA", name: "x", platform: "macos", publicKey: fake.publicKey }))).toBe(403);
    expect(status(() => hub.pair({ code: hub.issueCode().code, name: "x", platform: "macos", publicKey: "bm90IGEga2V5" }))).toBe(400);
    hub.pair({ code: hub.issueCode().code, name: "x", platform: "macos", publicKey: fake.publicKey });
    expect(status(() => hub.pair({ code: hub.issueCode().code, name: "x", platform: "macos", publicKey: fake.publicKey }))).toBe(409);
    expect(status(() => hub.pair({ code: 7, name: "x", platform: "macos", publicKey: fake.publicKey }))).toBe(400);
  });

  it("voids every open code after ten wrong ones", () => {
    const { hub } = setup();
    const { code } = hub.issueCode();
    for (let i = 0; i < 10; i++) expect(hub.codes.redeem(`WRONG${i}XX`)).toBe(false);
    expect(hub.codes.redeem(code)).toBe(false);
  });

  it("lets a code lapse after ten minutes", () => {
    let now = 1_000_000;
    const codes = new PairingCodes(() => now);
    const { code } = codes.issue();
    now += 10 * 60 * 1000;
    expect(codes.redeem(code)).toBe(false);
  });
});

describe("naming a device", () => {
  it("numbers a name already taken, and means the online one when a name fits two", async () => {
    const { hub } = setup();
    const first = await online(hub, "Studio MacBook");
    const second = await online(hub, "Studio MacBook");
    expect(hub.list().map((d) => d.name)).toEqual(["Studio MacBook", "Studio MacBook 2"]);
    first.drop();
    expect(hub.find("studio")?.id).toBe(second.id);
    expect(hub.find(undefined)?.id).toBe(second.id);
    expect(hub.find("Studio MacBook")?.id).toBe(first.id);
  });
});

describe("a device connecting", () => {
  it("is in once it signs KOS's nonce, and KOS's welcome proves KOS", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    expect(fake.closed).toBeUndefined();
    expect(fake.welcome?.name).toBe("Studio MacBook");
    expect(fake.welcomeVerifies(hostKey.publicKey)).toBe(true);
    expect(hub.list()[0]).toMatchObject({ online: true, consent: "device", permissions: { screen: true, input: true } });
  });

  it("is closed for a signature by another key, or an id KOS does not know", async () => {
    const { hub } = setup();
    const paired = await online(hub);
    const impostor = new FakeDevice(paired.id);
    hub.accept(impostor.socket);
    impostor.hello();
    expect(impostor.closed?.code).toBe(CLOSE.unauthorized);

    const stranger = new FakeDevice("dev_nobody");
    hub.accept(stranger.socket);
    stranger.hello();
    expect(stranger.closed?.code).toBe(CLOSE.unauthorized);
    expect(hub.list()[0]?.online).toBe(true);
  });

  it("names the check a refused hello failed, in the close and once a minute per id in the log, with no key or signature", async () => {
    let now = 1_000_000;
    const lines: string[] = [];
    const store = new DeviceStore(openDatabase(":memory:"));
    const hub = new DeviceHub({ store, hostKey, halted: () => false, now: () => now, log: (l) => lines.push(l) });
    const paired = await online(hub);
    const refuse = (fake: FakeDevice, over: Record<string, unknown> = {}): FakeDevice => {
      hub.accept(fake.socket);
      fake.hello(over);
      return fake;
    };

    const impostor = refuse(new FakeDevice(paired.id));
    expect(impostor.closed).toEqual({ code: CLOSE.unauthorized, reason: REFUSED_REASON["bad signature"] });
    const stranger = refuse(new FakeDevice("dev_nobody"));
    expect(stranger.closed).toEqual({ code: CLOSE.unauthorized, reason: REFUSED_REASON["unknown device"] });
    const old = refuse(new FakeDevice(paired.id), { protocol: 99 });
    expect(old.closed).toEqual({ code: CLOSE.version, reason: REFUSED_REASON["protocol version"] });
    expect(REFUSED_REASON["unknown device"]).toMatch(/^unknown device: .*pair again$/);

    // Each check its own line, the same id too: a key that fails and then a version that does are two things to know.
    expect(lines).toEqual([
      `devices: refused ${paired.id} (macos 0.1.0 on 26.4.1): bad signature`,
      "devices: refused dev_nobody (macos 0.1.0 on 26.4.1): unknown device",
      `devices: refused ${paired.id} (macos 0.1.0 on 26.4.1): protocol version`,
    ]);
    for (const line of lines) {
      expect(line).not.toContain(impostor.publicKey);
      expect(line).not.toContain(paired.publicKey);
    }
    // The same id refused again within the minute says nothing more; after it, once again.
    refuse(new FakeDevice("dev_nobody"));
    expect(lines).toHaveLength(3);
    now += 60_000;
    refuse(new FakeDevice("dev_nobody"));
    expect(lines.at(-1)).toBe("devices: refused dev_nobody (macos 0.1.0 on 26.4.1): unknown device");
    // What a device claims is written as one printable line: no line breaks, no terminal escapes.
    refuse(new FakeDevice("dev_\nfake log line"));
    expect(lines.at(-1)).toMatch(/^devices: refused dev_\?fake log line \(/);
    refuse(new FakeDevice("dev_\u001b[31mred"), { app: { version: "\u001b]0;title\u0007", platform: "chrome", os: "x" } });
    expect(lines.at(-1)).toBe("devices: refused dev_?[31mred (chrome ?]0;title? on x): unknown device");
    expect(lines.join("")).not.toMatch(/[\u0000-\u001f\u007f]/);
    // A signature is never written, whatever the check.
    refuse(new FakeDevice(paired.id), { signature: "c2lnbmF0dXJlLW1hcmtlcg==" });
    expect(lines.join("\n")).not.toContain("c2lnbmF0dXJlLW1hcmtlcg==");
    expect(hub.list()[0]?.online).toBe(true);
  });

  it("logs a flood of refused ids only so far, then again once their minute is up", () => {
    let now = 1_000_000;
    const lines: string[] = [];
    const hub = new DeviceHub({ store: new DeviceStore(openDatabase(":memory:")), hostKey, halted: () => false, now: () => now, log: (l) => lines.push(l) });
    const refuse = (id: string): void => {
      const fake = new FakeDevice(id);
      hub.accept(fake.socket);
      fake.hello();
    };
    for (let i = 0; i < 150; i++) refuse(`dev_flood${i}`);
    expect(lines).toHaveLength(100);
    refuse("dev_late");
    expect(lines).toHaveLength(100);
    now += 60_000;
    refuse("dev_late");
    expect(lines.at(-1)).toBe("devices: refused dev_late (macos 0.1.0 on 26.4.1): unknown device");
  });

  it("is closed for another protocol, a frame before hello, or no hello at all", () => {
    vi.useFakeTimers();
    const { hub } = setup();
    const old = new FakeDevice();
    hub.accept(old.socket);
    old.hello({ protocol: 99 });
    expect(old.closed?.code).toBe(CLOSE.version);

    const rude = new FakeDevice();
    hub.accept(rude.socket);
    rude.send({ t: "event", name: "session.ended", data: {} });
    expect(rude.closed?.code).toBe(CLOSE.malformed);

    const silent = new FakeDevice();
    hub.accept(silent.socket);
    vi.advanceTimersByTime(10_001);
    expect(silent.closed?.code).toBe(CLOSE.malformed);
  });

  it("replaces an older connection of the same device", async () => {
    const { hub } = setup();
    const first = await online(hub);
    const again = new FakeDevice(first.id, first.key);
    hub.accept(again.socket);
    again.hello();
    expect(first.closed?.code).toBe(CLOSE.replaced);
    expect(again.closed).toBeUndefined();
    expect(hub.list()[0]?.online).toBe(true);
  });
});

describe("a session", () => {
  it("is asked for on the device, and its actions carry its id", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    const device = hub.find(undefined)!;
    const session = await hub.begin({ conversation: "c1", device, task: "open Figma", requester: "Design", minutes: 15 });
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { task: "open Figma", requester: "Design", conversation: "c1", minutes: 15, session: session.id } });
    expect(session.space).toEqual({ width: 1232, height: 800 });
    await hub.act("c1", "pointer.click", { x: 5, y: 6, button: "left", count: 1 });
    expect(fake.calls.at(-1)).toEqual({ method: "pointer.click", params: { x: 5, y: 6, button: "left", count: 1, session: session.id } });
    expect(hub.list()[0]?.session).toMatchObject({ conversation: "c1", task: "open Figma", paused: false });
  });

  it("is refused when the owner denies it, the device is offline, busy, missing a permission, or KOS is halted", async () => {
    let halted = false;
    const { hub } = setup({ halted: () => halted });
    const fake = await online(hub);
    const device = hub.find("studio")!;
    const code = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
      try {
        await fn();
      } catch (err) {
        return err instanceof DeviceError ? err.code : String(err);
      }
      return undefined;
    };
    const begin = (conversation: string) => hub.begin({ conversation, device, task: "t", requester: "r", minutes: 5 });

    fake.answers.set("session.begin", () => ({ ok: false, code: "denied", message: "the owner said no" }));
    expect(await code(() => begin("c1"))).toBe("denied");

    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: true, until: Date.now() + 60_000, space: { width: 100, height: 100 } } }));
    await begin("c1");
    expect(await code(() => begin("c2"))).toBe("busy");

    halted = true;
    expect(await code(() => begin("c3"))).toBe("halted");
    halted = false;

    fake.send({ t: "state", permissions: { screen: false, input: true } });
    hub.end("c1");
    expect(await code(() => begin("c4"))).toBe("permission");

    fake.drop();
    expect(await code(() => begin("c5"))).toBe("offline");
  });

  it("follows the device: paused, resumed, ended by the owner", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    const session = await hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    fake.event("session.paused", { session: session.id, reason: "owner" });
    await expect(hub.act("c1", "keys.type", { text: "hi" })).rejects.toMatchObject({ code: "paused" });
    fake.event("session.resumed", { session: session.id });
    await hub.act("c1", "keys.type", { text: "hi" });
    fake.event("session.ended", { session: session.id, reason: "owner" });
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(hub.takeEnding("c1")).toBe("owner");
  });

  it("takes the longer time the owner gave it on the device", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    const session = await hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    const later = session.until + 15 * 60_000;
    fake.event("session.extended", { session: session.id, until: later });
    expect(hub.sessionOf("c1")?.until).toBe(later);
    fake.event("session.extended", { session: session.id, until: session.until - 1 });
    expect(hub.sessionOf("c1")?.until).toBe(later);
  });

  it("keeps the owner's settings, and refuses ones out of range", () => {
    const { hub } = setup();
    expect(hub.settings()).toEqual({ askMinutes: 15, unattended: false });
    expect(hub.updateSettings({ askMinutes: 30, unattended: true })).toEqual({ askMinutes: 30, unattended: true });
    expect(() => hub.updateSettings({ askMinutes: 0 })).toThrow(/1 to 480/);
    expect(() => hub.updateSettings({ askMinutes: 2.5 })).toThrow(/whole number/);
    expect(hub.settings().askMinutes).toBe(30);
  });

  it("ends when the device drops, and every one ends at the kill switch", async () => {
    const { hub } = setup();
    const laptop = await online(hub, "Laptop");
    const desktop = await online(hub, "Desktop");
    await hub.begin({ conversation: "a", device: hub.find("Laptop")!, task: "t", requester: "r", minutes: 5 });
    await hub.begin({ conversation: "b", device: hub.find("Desktop")!, task: "t", requester: "r", minutes: 5 });
    laptop.drop();
    expect(hub.sessionOf("a")).toBeUndefined();
    expect(hub.takeEnding("a")).toBe("offline");
    hub.endAll("host");
    await settle();
    expect(hub.sessionOf("b")).toBeUndefined();
    expect(desktop.calls.at(-1)?.method).toBe("session.end");
  });

  it("is over at its time on this side too, whatever the device says", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: true, until: Date.now() + 5, space: { width: 10, height: 10 } } }));
    await hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(hub.takeEnding("c1")).toBe("expired");
  });

  it("is forgotten when the owner unpairs it on the device, with any session it had", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    const other = await online(hub, "Office iMac");
    await hub.begin({ conversation: "c1", device: hub.find("Studio MacBook")!, task: "t", requester: "r", minutes: 5 });
    fake.send({ t: "unpair" });
    await settle();
    expect(hub.list().map((d) => d.name)).toEqual(["Office iMac"]);
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(fake.closed?.code).toBe(CLOSE.unauthorized);
    expect(other.closed).toBeUndefined();
  });

  it("is asked for while the hub says so, and a withdrawn ask takes the prompt down and gives back a late yes", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    fake.answers.delete("session.begin");
    const asked = hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    const failed = asked.catch((err: unknown) => err);
    await settle();
    expect(hub.asking("c1")).toBe(true);
    expect(hub.withdraw("c1")).toBe(true);
    expect(await failed).toMatchObject({ code: "stopped" });
    expect(hub.asking("c1")).toBe(false);
    const id = fake.calls[0]!.params["session"];
    expect(fake.calls.filter((c) => c.method === "session.end")).toEqual([{ method: "session.end", params: { session: id } }]);
    fake.answer("session.begin", { granted: true, until: Date.now() + 60_000, space: { width: 10, height: 10 } });
    await settle();
    expect(fake.calls.filter((c) => c.method === "session.end")).toHaveLength(2);
    expect(hub.sessionOf("c1")).toBeUndefined();
    expect(hub.withdraw("c1")).toBe(false);
  });

  it("tells an ask the owner never answered from one they refused", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    const begin = () => hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: false, reason: "unanswered" } }));
    await expect(begin()).rejects.toMatchObject({ code: "unanswered" });
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: false, reason: "withdrawn" } }));
    await expect(begin()).rejects.toMatchObject({ code: "stopped" });
    fake.answers.set("session.begin", () => ({ ok: true, result: { granted: false } }));
    await expect(begin()).rejects.toMatchObject({ code: "denied" });
  });

  it("waits for the owner to hand it back, and says when they kept it, it ended, or Stop came first", async () => {
    const { hub } = setup({ handBackWaitMs: 40 });
    const fake = await online(hub);
    const session = await hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    expect(await hub.untilHandedBack("c1")).toBe(false);
    fake.event("session.paused", { session: session.id, reason: "owner" });
    const back = hub.untilHandedBack("c1");
    fake.event("session.resumed", { session: session.id });
    expect(await back).toBe(true);
    fake.event("session.paused", { session: session.id, reason: "owner" });
    await expect(hub.untilHandedBack("c1")).rejects.toMatchObject({ code: "held" });
    const stop = new AbortController();
    const stopped = hub.untilHandedBack("c1", stop.signal);
    stop.abort();
    await expect(stopped).rejects.toMatchObject({ code: "stopped" });
    const ending = hub.untilHandedBack("c1");
    fake.event("session.ended", { session: session.id, reason: "owner" });
    await expect(ending).rejects.toMatchObject({ code: "no_session" });
  });

  it("is stopped from the dashboard, and goes with a device that is unpaired", async () => {
    const { hub } = setup();
    const fake = await online(hub);
    const id = hub.find(undefined)!.id;
    await hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    expect(hub.stopOn(id)).toBe(true);
    expect(hub.takeEnding("c1")).toBe("owner");
    await hub.begin({ conversation: "c1", device: hub.find(undefined)!, task: "t", requester: "r", minutes: 5 });
    expect(hub.remove(id)).toBe(true);
    expect(fake.closed?.code).toBe(CLOSE.unauthorized);
    expect(hub.list()).toEqual([]);
  });
});
