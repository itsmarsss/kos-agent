import { generateKeyPairSync } from "node:crypto";

import { openDatabase, type AuditEntry } from "@kos/harness";
import { describe, expect, it } from "vitest";

import type { Build, BuildKind } from "./builds.js";
import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { hereProof, rawPublicKey } from "./keys.js";
import { deviceRoutes, PREFIX } from "./routes.js";
import { DeviceStore } from "./store.js";
import { decide, DeviceUpdates, type DecideInput, type MacInstaller } from "./updates.js";

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };

const OLD: Build = { id: "000000000001", commit: "a".repeat(40), builtAt: 1 };
const NEW: Build = { id: "000000000002", commit: "b".repeat(40) };

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("deciding a device's update", () => {
  const base: DecideInput = { kind: "chrome", running: OLD, want: NEW, local: true, auto: true, owner: false };

  it("calls a device on KOS's build up to date, whatever commit built it", () => {
    expect(decide({ ...base, running: { ...NEW, commit: "c".repeat(40) } })).toEqual({ status: { state: "current", build: NEW }, action: "none" });
  });

  it("knows nothing of an app that says no build, or when KOS has none to hand it", () => {
    expect(decide({ ...base, running: undefined } as DecideInput)).toEqual({ status: { state: "unknown", build: NEW, reason: "unstamped" }, action: "none" });
    expect(decide({ ...base, want: undefined } as DecideInput)).toEqual({ status: { state: "unknown", reason: "unbuilt" }, action: "none" });
  });

  it("tells a Chrome behind on this computer to reload, and leaves one elsewhere be", () => {
    expect(decide(base)).toEqual({ status: { state: "behind", build: NEW, reason: "idle" }, action: "reload" });
    expect(decide({ ...base, local: false })).toMatchObject({ status: { reason: "remote" }, action: "none" });
  });

  it("tries each build once: one that reloaded and came back behind is left, until the owner asks", () => {
    const attempt = { device: "d", build: NEW.id, at: 0 };
    expect(decide({ ...base, attempt: { ...attempt, outcome: "reloading" } })).toEqual({ status: { state: "updating", build: NEW }, action: "none" });
    expect(decide({ ...base, attempt: { ...attempt, outcome: "still_behind" } })).toMatchObject({ status: { reason: "stuck" }, action: "none" });
    expect(decide({ ...base, attempt: { ...attempt, outcome: "failed", detail: "codesign failed" } })).toMatchObject({ status: { reason: "failed", detail: "codesign failed" } });
    expect(decide({ ...base, owner: true, attempt: { ...attempt, outcome: "still_behind" } })).toMatchObject({ action: "reload" });
  });

  it("updates nothing on its own when the owner turned that off, but does when they ask", () => {
    expect(decide({ ...base, auto: false })).toMatchObject({ status: { reason: "off" }, action: "none" });
    expect(decide({ ...base, auto: false, owner: true })).toMatchObject({ action: "reload" });
  });

  it("reinstalls KOS for Mac only when it is idle and signing keeps its permissions", () => {
    const mac: DecideInput = { ...base, kind: "mac", signed: true, idle: true };
    expect(decide(mac)).toEqual({ status: { state: "updating", build: NEW }, action: "install" });
    expect(decide({ ...mac, idle: false })).toMatchObject({ status: { state: "behind", reason: "idle" }, action: "none" });
    expect(decide({ ...mac, signed: false })).toMatchObject({ status: { state: "behind", reason: "signing" }, action: "none" });
    // The owner may take the permissions cost; an idle window is still waited for.
    expect(decide({ ...mac, signed: false, owner: true })).toMatchObject({ action: "install" });
    expect(decide({ ...mac, signed: false, owner: true, idle: false })).toMatchObject({ status: { reason: "idle" }, action: "none" });
  });

  it("rebuilds a KOS for Mac from before builds were stamped only when the owner asks", () => {
    const mac: DecideInput = { ...base, kind: "mac", running: undefined, signed: true, idle: true } as DecideInput;
    expect(decide(mac)).toMatchObject({ status: { state: "unknown" }, action: "none" });
    expect(decide({ ...mac, owner: true })).toMatchObject({ action: "install" });
    expect(decide({ ...mac, owner: true, local: false })).toMatchObject({ status: { state: "unknown" }, action: "none" });
  });

  it("only says an iPhone behind: it updates from Xcode", () => {
    expect(decide({ ...base, kind: "phone", local: false, owner: true })).toEqual({ status: { state: "behind", build: NEW, reason: "xcode" }, action: "none" });
  });
});

/** A hub with updates on, a stub installer, and devices to connect as KOS for Chrome, KOS for Mac and KOS for iPhone would. */
type Installed = { ok: true } | { ok: false; why: string };

function setup(over: { signed?: boolean; install?: () => Promise<Installed>; idle?: () => boolean; want?: Partial<Record<BuildKind, Build>>; store?: DeviceStore; localProblem?: string } = {}) {
  const store = over.store ?? new DeviceStore(openDatabase(":memory:"));
  const localKey = Buffer.alloc(32, 7);
  const hub = new DeviceHub({ store, hostKey, halted: () => false, log: () => undefined, ...(over.localProblem ? {} : { localKey }) });
  const audits: AuditEntry[] = [];
  const installs: string[] = [];
  const want: Partial<Record<BuildKind, Build>> = { chrome: NEW, mac: NEW, phone: NEW, ...over.want };
  const mac: MacInstaller = {
    signed: async () => over.signed ?? true,
    install: async (line) => {
      installs.push("install");
      line("Built build/KOS for Mac.app");
      return over.install ? over.install() : { ok: true };
    },
    commands: { signing: "cd app && scripts/signing.sh setup", install: "cd app && scripts/bundle.sh --install" },
  };
  const hashed: BuildKind[] = [];
  const updates = new DeviceUpdates({ hub, store, expected: (k, fresh) => (fresh && hashed.push(k), want[k]), mac, idle: over.idle ?? (() => true), ...(over.localProblem ? { localProblem: over.localProblem } : {}), audit: (e) => audits.push(e), log: () => undefined });
  updates.start();
  const pair = (platform: string, name: string): FakeDevice => {
    const fake = new FakeDevice();
    const { code } = hub.issueCode();
    fake.id = hub.pair({ code, name, platform, publicKey: fake.publicKey }).device;
    return fake;
  };
  /** The device's line, opened from this computer unless said otherwise, with the build it says it runs; a Mac proves it is here. */
  const connect = async (fake: FakeDevice, build: Build | undefined, local = true, more: Record<string, unknown> = {}): Promise<FakeDevice> => {
    const again = new FakeDevice(fake.id, fake.key);
    hub.accept(again.socket, { local });
    again.hello({ ...(build ? { build } : {}), here: hereProof(localKey, again.challenged!, fake.id), ...more });
    await settle();
    await settle();
    return again;
  };
  const outcomes = () => audits.map((a) => a.args["outcome"]);
  return { store, hub, updates, audits, installs, pair, connect, outcomes, want, hashed };
}

describe("KOS for Chrome behind", () => {
  it("is told to reload, reloads once, and comes back on the new build", async () => {
    const { pair, connect, updates, outcomes, audits } = setup();
    const chrome = pair("chrome", "Chrome");
    const line = await connect(chrome, OLD);
    expect(line.updates).toEqual([{ t: "update", state: "behind", build: NEW, reason: "idle", action: "reload" }]);
    expect(updates.statusOf(chrome.id)).toMatchObject({ state: "behind", reason: "idle" });
    line.event("update.state", { build: NEW.id, state: "reloading" });
    expect(updates.statusOf(chrome.id)).toEqual({ state: "updating", build: NEW });
    line.drop();
    const back = await connect(chrome, NEW);
    expect(updates.statusOf(chrome.id)).toEqual({ state: "current", build: NEW });
    expect(back.updates).toEqual([{ t: "update", state: "current", build: NEW }]);
    expect(outcomes()).toEqual(["reloading", "updated"]);
    expect(audits[1]).toMatchObject({ tool: "device.update", args: { kind: "chrome", from: OLD.id, to: NEW.id, outcome: "updated", by: "kos" }, isError: false });
  });

  it("that reloaded and is still behind is not told again, and says so, until the owner presses Update now", async () => {
    const { pair, connect, updates, outcomes, audits } = setup();
    const chrome = pair("chrome", "Chrome");
    const line = await connect(chrome, OLD);
    line.event("update.state", { build: NEW.id, state: "reloading" });
    line.drop();
    // Reloaded from a folder that is not KOS's dist: the same old build.
    const back = await connect(chrome, OLD);
    expect(back.updates).toEqual([{ t: "update", state: "behind", build: NEW, reason: "stuck" }]);
    expect(outcomes()).toEqual(["reloading", "still_behind"]);
    const again = await connect(chrome, OLD);
    expect(again.updates.map((u) => u.action)).toEqual([undefined]);
    expect(await updates.updateNow(chrome.id)).toMatchObject({ state: "behind", reason: "idle" });
    expect(again.updates.at(-1)).toMatchObject({ action: "reload", force: true });
    again.event("update.state", { build: NEW.id, state: "reloading" });
    expect(audits.at(-1)).toMatchObject({ args: { kind: "chrome", outcome: "reloading", by: "owner" } });
  });

  it("spends a forced reload on the line it was told on: a reload whose word was lost is not forced again", async () => {
    const { pair, connect, updates } = setup();
    const chrome = pair("chrome", "Chrome");
    const line = await connect(chrome, OLD);
    await updates.updateNow(chrome.id);
    expect(line.updates.at(-1)).toMatchObject({ force: true });
    line.drop();
    const back = await connect(chrome, OLD);
    expect(back.updates.at(-1)).toMatchObject({ action: "reload" });
    expect(back.updates.at(-1)).not.toHaveProperty("force");
  });

  it("whose folder never comes to hold the build is still behind, and not told to reload again", async () => {
    const { pair, connect, updates, outcomes, store } = setup();
    const chrome = pair("chrome", "Chrome");
    const line = await connect(chrome, OLD);
    line.event("update.state", { build: NEW.id, state: "missing" });
    await settle();
    expect(store.attempt(chrome.id, NEW.id)).toMatchObject({ outcome: "still_behind", detail: "its folder is not this KOS's" });
    expect(outcomes()).toEqual(["still_behind"]);
    expect(updates.statusOf(chrome.id)).toMatchObject({ state: "behind", reason: "stuck" });
    expect(line.updates.at(-1)).not.toHaveProperty("action");
  });

  it("is told again on a new line until it reloads: a line that dropped before it was idle is not a reload", async () => {
    const { pair, connect, outcomes } = setup();
    const chrome = pair("chrome", "Chrome");
    (await connect(chrome, OLD)).drop();
    const back = await connect(chrome, OLD);
    expect(back.updates).toEqual([{ t: "update", state: "behind", build: NEW, reason: "idle", action: "reload" }]);
    expect(outcomes()).toEqual([]);
  });

  it("on another computer is behind and left be", async () => {
    const { pair, connect } = setup();
    const line = await connect(pair("chrome", "Laptop Chrome"), OLD, false);
    expect(line.updates).toEqual([{ t: "update", state: "behind", build: NEW, reason: "remote" }]);
  });

  it("that says a build that does not read is let in, as one of no build", async () => {
    const { pair, connect, updates, hub } = setup();
    const chrome = pair("chrome", "Chrome");
    const line = await connect(chrome, { id: "not hex", commit: "" } as Build);
    expect(line.closed).toBeUndefined();
    expect(hub.list()[0]).not.toHaveProperty("build");
    expect(updates.statusOf(chrome.id)).toMatchObject({ state: "unknown", reason: "unstamped" });
  });

  it("that says no build is unknown, and told nothing it would act on", async () => {
    const { pair, connect, updates } = setup();
    const chrome = pair("chrome", "Old Chrome");
    const line = await connect(chrome, undefined);
    expect(updates.statusOf(chrome.id)).toEqual({ state: "unknown", build: NEW, reason: "unstamped" });
    expect(line.updates.every((u) => u.action === undefined)).toBe(true);
  });
});

describe("KOS for Mac behind", () => {
  it("is reinstalled once when idle, audited, and is up to date when it comes back", async () => {
    let idle = false;
    const { pair, connect, updates, installs, outcomes, hub } = setup({ idle: () => idle });
    const mac = pair("macos", "Studio");
    const line = await connect(mac, OLD);
    expect(updates.statusOf(mac.id)).toMatchObject({ state: "behind", reason: "idle" });
    expect(installs).toEqual([]);
    idle = true;
    // A session or a turn ending: the hub or the panel says something changed.
    updates.poke();
    updates.poke();
    await settle();
    await settle();
    expect(installs).toEqual(["install"]);
    expect(line.updates.map((u) => u.state)).toEqual(["behind", "updating"]);
    line.drop();
    await connect(mac, NEW);
    expect(updates.statusOf(mac.id)).toEqual({ state: "current", build: NEW });
    expect(outcomes()).toEqual(["installing", "updated"]);
    expect(hub.list()[0]).toMatchObject({ build: NEW, local: true });
  });

  it("is installed once per build: one that comes back still behind is not built again", async () => {
    const { pair, connect, installs, outcomes } = setup();
    const mac = pair("macos", "Studio");
    (await connect(mac, OLD)).drop();
    await settle();
    const back = await connect(mac, OLD);
    expect(installs).toEqual(["install"]);
    expect(outcomes()).toEqual(["installing", "still_behind"]);
    expect(back.updates.at(-1)).toMatchObject({ state: "behind", reason: "stuck", command: "cd app && scripts/bundle.sh --install" });
  });

  it("whose build fails says why and is not tried again on its own", async () => {
    const { pair, connect, installs, updates } = setup({ install: async () => ({ ok: false, why: "codesign failed" }) });
    const mac = pair("macos", "Studio");
    const line = await connect(mac, OLD);
    await settle();
    expect(updates.statusOf(mac.id)).toEqual({ state: "behind", build: NEW, reason: "failed", detail: "codesign failed", command: "cd app && scripts/bundle.sh --install" });
    expect(line.updates.at(-1)).toMatchObject({ reason: "failed", command: "cd app && scripts/bundle.sh --install" });
    updates.poke();
    await connect(mac, OLD);
    expect(installs).toEqual(["install"]);
  });

  it("without signing is not installed on its own: the owner is told once, with the command, and may start it", async () => {
    const { pair, connect, installs, updates, audits } = setup({ signed: false });
    const mac = pair("macos", "Studio");
    const line = await connect(mac, OLD);
    expect(installs).toEqual([]);
    expect(line.updates).toEqual([{ t: "update", state: "behind", build: NEW, reason: "signing", command: "cd app && scripts/signing.sh setup" }]);
    updates.poke();
    await settle();
    expect(line.updates).toHaveLength(1);
    await updates.updateNow(mac.id);
    await settle();
    expect(installs).toEqual(["install"]);
    expect(audits[0]).toMatchObject({ args: { kind: "mac", outcome: "installing", by: "owner" } });
  });

  it("on another computer is behind and left be", async () => {
    const { pair, connect, installs, updates } = setup();
    const mac = pair("macos", "Laptop");
    await connect(mac, OLD, false);
    expect(updates.statusOf(mac.id)).toMatchObject({ state: "behind", reason: "remote" });
    expect(installs).toEqual([]);
  });

  it("installs one at a time", async () => {
    let finish: (ok: Installed) => void = () => undefined;
    const { pair, connect, installs } = setup({ install: () => new Promise((r) => (finish = r)) });
    await connect(pair("macos", "One"), OLD);
    await connect(pair("macos", "Two"), OLD);
    expect(installs).toEqual(["install"]);
    finish({ ok: true });
    await settle();
    await settle();
    expect(installs).toEqual(["install", "install"]);
  });
});

describe("an update cut short, or overtaken", () => {
  it("is failed at start when a restart cut its install off, and Update now tries it again", async () => {
    const store = new DeviceStore(openDatabase(":memory:"));
    const first = setup({ store });
    const mac = first.pair("macos", "Studio");
    store.setAttempt({ device: mac.id, build: NEW.id, from: OLD.id, outcome: "installing" });
    first.updates.stop();
    // The next process: nothing of its own is installing.
    const next = setup({ store });
    expect(store.attempt(mac.id, NEW.id)).toMatchObject({ outcome: "failed", detail: "KOS restarted during the install" });
    expect(next.audits[0]).toMatchObject({ args: { kind: "mac", outcome: "failed" }, result: "failed: KOS restarted during the install" });
    await next.connect(mac, OLD);
    expect(next.updates.statusOf(mac.id)).toMatchObject({ reason: "failed", detail: "KOS restarted during the install" });
    await next.updates.updateNow(mac.id);
    await settle();
    expect(next.installs).toEqual(["install"]);
  });

  it("lets Update now clear an install this process does not run, and not one it does", async () => {
    let finish: (ok: Installed) => void = () => undefined;
    const { pair, connect, updates, installs, store } = setup({ install: () => new Promise((r) => (finish = r)) });
    const mac = pair("macos", "Studio");
    await connect(mac, OLD);
    expect(installs).toEqual(["install"]);
    await updates.updateNow(mac.id);
    expect(store.attempt(mac.id, NEW.id)?.outcome).toBe("installing");
    expect(installs).toEqual(["install"]);
    finish({ ok: true });
  });

  it("hashes the Mac's sources again before it installs, and builds nothing when they are what runs", async () => {
    const t = setup();
    const mac = t.pair("macos", "Studio");
    // The owner built and installed by hand from newer sources; KOS's start-time hash is out of date.
    const handBuilt: Build = { id: "000000000003", commit: "" };
    const line = await t.connect(mac, OLD);
    expect(t.hashed).toContain("mac");
    expect(t.installs).toEqual(["install"]);
    line.drop();
    t.want.mac = handBuilt;
    await t.connect(mac, handBuilt);
    expect(t.updates.statusOf(mac.id)).toEqual({ state: "current", build: handBuilt });
    expect(t.installs).toEqual(["install"]);
  });
});

describe("where a device runs", () => {
  it("is not this computer for a Mac on loopback that cannot prove it, nor for a line a proxy passed on", async () => {
    const { pair, connect, updates, installs } = setup();
    const mac = pair("macos", "Behind a proxy");
    await connect(mac, OLD, true, { here: "bm90IHRoZSBwcm9vZg==" });
    expect(updates.statusOf(mac.id)).toMatchObject({ reason: "remote" });
    expect(installs).toEqual([]);
  });

  it("is unproved for a Mac on loopback while this computer's secret will not read: nothing installed, and why", async () => {
    const why = "KOS can't tell this Mac is its own: remove ~/.kos/device-local.key and KOS makes another";
    const { pair, connect, updates, installs, hub } = setup({ localProblem: why });
    const routes = deviceRoutes(() => hub, (id) => id, undefined, () => updates);
    const mac = pair("macos", "Studio");
    await connect(mac, OLD);
    expect(updates.statusOf(mac.id)).toEqual({ state: "behind", build: NEW, reason: "unproved", detail: why });
    expect(installs).toEqual([]);
    expect(await routes.handle({ method: "GET", path: PREFIX })).toMatchObject({ body: { devices: [{ update: { reason: "unproved", detail: why } }] } });
    // A Chrome on the same line is not asked to prove anything.
    const chrome = pair("chrome", "Chrome");
    expect((await connect(chrome, OLD)).updates[0]).toMatchObject({ action: "reload" });
  });

  it("knows a Chrome installed from the store updates through Chrome, not KOS", async () => {
    const { pair, connect, updates } = setup();
    const chrome = pair("chrome", "Store Chrome");
    const line = await connect(chrome, OLD, true, { install: "normal" });
    expect(updates.statusOf(chrome.id)).toEqual({ state: "behind", build: NEW, reason: "store" });
    expect(line.updates.every((u) => u.action === undefined)).toBe(true);
  });
});

describe("KOS for iPhone behind", () => {
  it("is told an update is ready in Xcode, and nothing is run", async () => {
    const { pair, connect, updates, installs, audits } = setup();
    const phone = pair("ios", "Pocket");
    const line = await connect(phone, OLD, false);
    expect(line.updates).toEqual([{ t: "update", state: "behind", build: NEW, reason: "xcode" }]);
    expect(await updates.updateNow(phone.id)).toMatchObject({ reason: "xcode" });
    expect([installs, audits]).toEqual([[], []]);
  });
});

describe("the update routes", () => {
  it("list each device's build and where it stands, take Update now, and keep the setting", async () => {
    const { pair, connect, hub, updates, installs } = setup({ signed: false });
    const routes = deviceRoutes(() => hub, (id) => id, undefined, () => updates);
    const mac = pair("macos", "Studio");
    await connect(mac, OLD);
    expect(await routes.handle({ method: "GET", path: PREFIX })).toMatchObject({
      body: { devices: [{ id: mac.id, build: OLD, update: { state: "behind", reason: "signing" } }], settings: { autoUpdate: true } },
    });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/update`, body: { id: mac.id } })).toMatchObject({ status: 200, body: { update: { state: "updating" } } });
    expect(installs).toEqual(["install"]);
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/update`, body: {} })).toMatchObject({ status: 400 });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/update`, body: { id: "dev_nope" } })).toMatchObject({ status: 404 });
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/settings`, body: { autoUpdate: false } })).toMatchObject({ body: { autoUpdate: false } });
    expect(await deviceRoutes(() => hub, (id) => id).handle({ method: "POST", path: `${PREFIX}/update`, body: { id: mac.id } })).toMatchObject({ status: 503 });
  });

  it("say an offline device has no update to start", async () => {
    const { pair, hub, updates } = setup();
    const routes = deviceRoutes(() => hub, (id) => id, undefined, () => updates);
    const mac = pair("macos", "Studio");
    expect(await routes.handle({ method: "POST", path: `${PREFIX}/update`, body: { id: mac.id } })).toMatchObject({ status: 409 });
  });
});
