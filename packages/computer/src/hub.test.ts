import { generateKeyPairSync } from "node:crypto";

import { openDatabase } from "@kos/harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDevice } from "./device.fixture.js";
import { DeviceHub, PairError } from "./hub.js";
import { rawPublicKey } from "./keys.js";
import { DeviceError } from "./link.js";
import { PairingCodes } from "./pairing.js";
import { CLOSE } from "./protocol.js";
import { DeviceStore } from "./store.js";

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };

function setup(over: { halted?: () => boolean } = {}) {
  const store = new DeviceStore(openDatabase(":memory:"));
  const hub = new DeviceHub({ store, hostKey, halted: over.halted ?? (() => false), beginTimeoutMs: 200, callTimeoutMs: 200 });
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
    expect(fake.calls[0]).toMatchObject({ method: "session.begin", params: { task: "open Figma", requester: "Design", minutes: 15, session: session.id } });
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
