import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deviceInfo, keyFrom, openDatabase, p256Pair, sealToHost, Vault, type P256Pair } from "@kos/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDevice } from "./device.fixture.js";
import { DeviceHub } from "./hub.js";
import { hereProof, rawPublicKey } from "./keys.js";
import { MacVault, unlockAtLogin } from "./macvault.js";
import { DeviceStore } from "./store.js";

const hostPrivate = generateKeyPairSync("ed25519").privateKey;
const hostKey = { privateKey: hostPrivate, publicKey: rawPublicKey(hostPrivate) };
const localKey = Buffer.alloc(32, 7);
const PASS = "a long passphrase";
const settle = () => new Promise((r) => setTimeout(r, 0));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kos-macvault-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** KOS for Mac's side of the vault calls, with a software P-256 key where the Secure Enclave would be. */
function answersVault(fake: FakeDevice, pair: P256Pair): void {
  const key = pair.pub.toString("base64");
  fake.answers.set("vault.key", () => ({ ok: true, result: { key, store: "software" } }));
  fake.answers.set("vault.unwrap", (p) => {
    if (p.key !== key) return { ok: false, code: "key", message: "This Mac holds another vault key." };
    const vault = p.vault as string;
    const slot = p.slot as string;
    const kek = keyFrom(pair.priv, pair.pub, Buffer.from(p.epk as string, "base64"), deviceInfo(vault, slot));
    return { ok: true, result: { ...sealToHost(kek, Buffer.from(p.hostEpk as string, "base64"), vault, slot) } };
  });
}

function setup() {
  const store = new DeviceStore(openDatabase(":memory:"));
  const hub = new DeviceHub({ store, hostKey, halted: () => false, log: () => undefined, localKey });
  const macs = new MacVault(() => hub);
  const { code } = hub.issueCode();
  const paired = new FakeDevice();
  paired.id = hub.pair({ code, name: "Studio Mac", platform: "macos", publicKey: paired.publicKey }).device;
  const pair = p256Pair();
  /** The Mac's line: from loopback and proved here unless said otherwise. */
  const connect = async (line: { local?: boolean; proved?: boolean } = {}): Promise<FakeDevice> => {
    const fake = new FakeDevice(paired.id, paired.key);
    answersVault(fake, pair);
    hub.accept(fake.socket, { local: line.local ?? true });
    fake.hello(line.proved === false ? {} : { here: hereProof(localKey, fake.challenged!, paired.id) });
    await settle();
    return fake;
  };
  return { hub, macs, connect, id: paired.id };
}

async function vaultWithMac(macs: MacVault, id: string): Promise<{ handle: string }> {
  const vault = new Vault({ dir: join(root, "secrets") });
  await vault.init({ passphrase: PASS });
  const handle = vault.add({ label: "OpenAI", kind: "apikey", values: { token: "sk-proj-unlocked-at-login-0123" } });
  await vault.addDeviceSlot("Studio Mac", await macs.key(id), macs.unwrapper(id));
  return { handle };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("the vault opened by KOS for Mac", () => {
  it("adds a device slot with the Mac's key, and the Mac answers the slot's key sealed to the host's ephemeral point", async () => {
    const { macs, connect, id } = setup();
    const mac = await connect();
    expect(macs.here()).toEqual({ id, name: "Studio Mac" });
    const { handle } = await vaultWithMac(macs, id);
    const asked = mac.calls.find((c) => c.method === "vault.unwrap")!;
    expect(Object.keys(asked.params).sort()).toEqual(["epk", "hostEpk", "key", "slot", "vault"]);
    const fresh = new Vault({ dir: join(root, "secrets") });
    expect(await fresh.unlockWithDevice(macs.anyHere())).toBe(true);
    expect(fresh.value(handle, "token")).toBe("sk-proj-unlocked-at-login-0123");
  }, 30_000);

  it("opens a locked vault when the Mac here connects", async () => {
    const { hub, macs, connect, id } = setup();
    await connect();
    await vaultWithMac(macs, id);
    hub.closeAll();
    const vault = new Vault({ dir: join(root, "secrets") });
    const lines: string[] = [];
    const stop = unlockAtLogin({ vault, hub, macs, log: (l) => lines.push(l) });
    await settle();
    expect(vault.status().state).toBe("locked");
    await connect();
    await until(() => vault.status().state === "ready");
    expect(vault.status().state).toBe("ready");
    expect(lines).toContain("secrets: KOS for Mac opened the vault");
    stop();
  }, 30_000);

  it("asks no Mac that is not proved here: one through a proxy, or one without the here proof", async () => {
    for (const line of [{ local: false }, { proved: false }]) {
      const { hub, macs, connect, id } = setup();
      const mac = await connect(line);
      expect(macs.here()).toMatchObject({ reason: expect.stringMatching(/not running on this computer/) });
      await expect(hub.vaultCall(id, "vault.key", {})).rejects.toMatchObject({ code: "not_here" });
      await expect(macs.key(id)).rejects.toMatchObject({ code: "refused" });
      expect(mac.calls).toEqual([]);
    }
  });

  it("leaves the vault locked with the Mac's reason when its answer does not open the slot", async () => {
    const { hub, macs, connect, id } = setup();
    await connect();
    await vaultWithMac(macs, id);
    hub.closeAll();
    const vault = new Vault({ dir: join(root, "secrets") });
    const mac = await connect();
    // An answer sealed for another slot: the host's open refuses it.
    mac.answers.set("vault.unwrap", (p) => ({ ok: true, result: { ...sealToHost(Buffer.alloc(32, 1), Buffer.from(p.hostEpk as string, "base64"), p.vault as string, "s9") } }));
    expect(await vault.unlockWithDevice(macs.anyHere())).toBe(false);
    expect(vault.status()).toMatchObject({ state: "locked", atLogin: expect.stringMatching(/not sealed to this request/) });
    mac.answers.set("vault.unwrap", () => ({ ok: false, code: "key", message: "This Mac holds another vault key." }));
    expect(await vault.unlockWithDevice(macs.anyHere())).toBe(false);
    expect(vault.status().atLogin).toMatch(/another vault key/);
    await vault.unlock(PASS);
    expect(vault.status().state).toBe("ready");
  }, 30_000);
});
