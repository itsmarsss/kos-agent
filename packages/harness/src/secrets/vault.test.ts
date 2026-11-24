import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entryAad, indexKey, indexMac, passphraseKek, seal, sealDek, slotAad, unseal, Vault, VaultError, type DeviceUnwrapper, type VaultFile } from "./vault.js";
import { deviceInfo, keyFrom, openFromDevice, p256Pair, passphraseScalar, sealToHost, type P256Pair } from "./vaultkeys.js";

const range = (start: number, n: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (start + i) & 255));

/*
 * Known answers, worked out apart from vault.ts: AES-GCM, HKDF and HMAC with
 * WebCrypto, scrypt with `openssl kdf ... SCRYPT`. docs/secrets.md lists them.
 */
const KAT = {
  dek: range(0x00, 32),
  kek: range(0x20, 32),
  nonce: range(0x60, 12),
  slotNonce: range(0x70, 12),
  vault: "v_0123456789abcdef",
  entry: "e_00000000000000a1",
  record: '{"handle":"github-login-9xq1","label":"GitHub","kind":"login","values":{"username":"owner","password":"hunter2-but-longer"}}',
  entryCt:
    "kfnzNNUk7wpeLNtMG/mpNkRY5ebjDVz0mtnxXV7e1WTT+12UhjE34VJVo4B88bGI7kHG2wtH0KUJ8dUTxkivJtt9fKNpWCCCyAcogt59gGBDnVfCLv8smGJNJgnrHAk1EwLuZPRcQKXzxPvdQe/bqwuXYStwuFK2pPM6ZrQn9Ysb6YNl0ull1ZseAaw=",
  slotCt: "aX9gaNOtwVkgEipLZP8OHHha0rwdDXbo2fh7U8hyhwKBISZBG/W6aqbovibkPWZ9",
  indexKey: "4712494fa203f3ccddde2bf44f86a6b395a054895e762b055f45e8351ec3f614",
  mac: "04+O45DO+QbFDTgHede6WyIrP4OmVJWUnhY0ranqLgE=",
  passphrase: "correct horse battery staple",
  salt: range(0x40, 16),
  passphraseKek: "d383505afdc30eca3c262fccd3eba2260547640663d604b3983d8c3144173d4e",
};

describe("vault format vectors, version 1", () => {
  it("seals an entry under its AAD", () => {
    const sealed = seal(KAT.dek, KAT.nonce, Buffer.from(KAT.record), entryAad(KAT.vault, KAT.entry, "k1", 1));
    expect(sealed.toString("base64")).toBe(KAT.entryCt);
    expect(unseal(KAT.dek, KAT.nonce, sealed, entryAad(KAT.vault, KAT.entry, "k1", 1)).toString()).toBe(KAT.record);
  });

  it("refuses an entry read under another id, vault or data key", () => {
    const sealed = Buffer.from(KAT.entryCt, "base64");
    expect(() => unseal(KAT.dek, KAT.nonce, sealed, entryAad(KAT.vault, "e_00000000000000b2", "k1", 1))).toThrow();
    expect(() => unseal(KAT.dek, KAT.nonce, sealed, entryAad("v_fedcba9876543210", KAT.entry, "k1", 1))).toThrow();
    expect(() => unseal(KAT.dek, KAT.nonce, sealed, entryAad(KAT.vault, KAT.entry, "k2", 1))).toThrow();
  });

  it("wraps the data key in a slot", () => {
    expect(seal(KAT.kek, KAT.slotNonce, KAT.dek, slotAad(KAT.vault, "s1", "k1", 1)).toString("base64")).toBe(KAT.slotCt);
  });

  it("derives the index key and MACs the slots and each entry's bytes", () => {
    expect(indexKey(KAT.dek, 1).toString("hex")).toBe(KAT.indexKey);
    const doc = {
      version: 1 as const,
      vault: KAT.vault,
      dek: "k1",
      slots: [{ id: "s1", kind: "keyfile" as const, wrap: { alg: "A256GCM" as const, nonce: KAT.slotNonce.toString("base64"), ct: KAT.slotCt } }],
      entries: [
        { id: "e_00000000000000b2", nonce: range(0x80, 12).toString("base64"), ct: range(0xa0, 40).toString("base64") },
        { id: KAT.entry, nonce: KAT.nonce.toString("base64"), ct: KAT.entryCt },
      ],
    };
    expect(indexMac(KAT.dek, doc, 7)).toBe(KAT.mac);
    expect(indexMac(KAT.dek, { ...doc, entries: [doc.entries[0]!, { ...doc.entries[1]!, ct: flip(KAT.entryCt) }] }, 7)).not.toBe(KAT.mac);
  });

  it("derives a passphrase key with scrypt N=2^17 r=8 p=1", async () => {
    expect((await passphraseKek(KAT.passphrase, KAT.salt)).toString("hex")).toBe(KAT.passphraseKek);
  });

  it("matches RFC 7914's scrypt vector at its parameters", async () => {
    const key = await passphraseKek("pleaseletmein", Buffer.from("SodiumChloride"), { N: 16_384, r: 8, p: 1 });
    expect(key.toString("hex")).toBe("7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2");
  });
});


/*
 * Version 2's device wrap and `vault.unwrap` answer, worked out apart from
 * vaultkeys.ts with WebCrypto (ECDH P-256, HKDF-SHA256, AES-GCM, HMAC).
 * Private scalars: the device 0x01..0x20, the slot's ephemeral 0x21..0x40,
 * the host's 0x41..0x60, the Mac's 0x61..0x80. docs/secrets.md lists them.
 */
const KAT2 = {
  slot: "s2",
  devicePub: "BFFcPW6545a5BNP+yn9U/c0MwemXvzddylFa0KbDtANfRTa+OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q=",
  epk: "BB8UAUa/sbJR+E9N2+DUzc/Xev2YSpUg41eUAh+DErue7JlaCLH6dwTfPcwLUKlmUmP7dxH5X5+KRJxQluR8iSs=",
  deviceKek: "dd01116d9d877add3e3d39300b02d3e22fc63839f0e60c3ca5bc2942683eb1bb",
  slotNonce: range(0x90, 12),
  deviceCt: "B4kuvJZBih43PvkKGWdhU7VQdsXjf5bLcWPstBgcrtgRa1N96HlDBpVMVXasY6aX",
  hostEpk: "BCYe+9NVDPBo7wE+1zZroy9db+VXtLKrzoreWMuhaKVeF4igsppWpqvsQITAyWvT3LymtQfzXb6p6YVwhHnYvck=",
  macEpk: "BL1XFLnCBABBHx5R2/9jZH8F0dcLVfwgDGytEML0YU3B5QSFYvcx9UVzwEIk2XOpFqWfUmqCaAdvwc+pKl8UPxk=",
  answerNonce: range(0xa0, 12),
  answerCt: "EpbbcSbHkfEcE401B7uuTLjVclhTayRerALyzUtNDTB7Z4iWXdY+S7OrKMew2sEj",
  passScalar: "76722d10796a28d6569584894263e95d0fd1a7e627412eac59866185985ab9ae",
  passPub: "BKWjDcecXuDceGHPgMWl3JMQNOZkwWNSGq76iyjJ3PY38Gv2ghmTZAukF7zGlEVw5i68cuRhZ5Cj+mke+oD5/R8=",
  entryCt:
    "kfnzNNUk7wpeLNtMG/mpNkRY5ebjDVz0mtnxXV7e1WTT+12UhjE34VJVo4B88bGI7kHG2wtH0KUJ8dUTxkivJtt9fKNpWCCCyAcogt59gGBDnVfCLv8smGJNJgnrHAk1EwLuZPRcQKXzxPvdQe/bqwuXYStwuFK2pPM6ZhVfwv1cxiQVEf1eQGAsTIs=",
  indexKey: "6697f26db5d19592e42766fd7a33e361b351bcb5b50c0ce4208100c8714be2e5",
  mac: "CTfLEbIQWQysLbKebQrP/GsYvngI1XUf9/UVfNGkscI=",
};

const pairOf = (start: number): P256Pair => p256Pair(range(start, 32));

describe("vault format vectors, version 2", () => {
  it("seals an entry and derives the index key under kos-vault/2", () => {
    expect(seal(KAT.dek, KAT.nonce, Buffer.from(KAT.record), entryAad(KAT.vault, KAT.entry, "k1")).toString("base64")).toBe(KAT2.entryCt);
    expect(indexKey(KAT.dek).toString("hex")).toBe(KAT2.indexKey);
  });

  it("seals the data key to a device's point, and the device makes the same key", () => {
    const device = pairOf(0x01);
    expect(device.pub.toString("base64")).toBe(KAT2.devicePub);
    const { wrap, kek } = sealDek(device.pub, KAT.dek, deviceInfo(KAT.vault, KAT2.slot), slotAad(KAT.vault, KAT2.slot, "k1"), pairOf(0x21), KAT2.slotNonce);
    expect(wrap).toEqual({ alg: "ECDH-P256-A256GCM", epk: KAT2.epk, nonce: KAT2.slotNonce.toString("base64"), ct: KAT2.deviceCt });
    expect(kek.toString("hex")).toBe(KAT2.deviceKek);
    expect(keyFrom(device.priv, device.pub, Buffer.from(KAT2.epk, "base64"), deviceInfo(KAT.vault, KAT2.slot)).toString("hex")).toBe(KAT2.deviceKek);
    // Under another vault or slot the key is another.
    expect(keyFrom(device.priv, device.pub, Buffer.from(KAT2.epk, "base64"), deviceInfo(KAT.vault, "s3")).toString("hex")).not.toBe(KAT2.deviceKek);
  });

  it("answers vault.unwrap sealed to the host's ephemeral point, and the host opens it", () => {
    const host = pairOf(0x41);
    expect(host.pub.toString("base64")).toBe(KAT2.hostEpk);
    const answer = sealToHost(Buffer.from(KAT2.deviceKek, "hex"), host.pub, KAT.vault, KAT2.slot, pairOf(0x61), KAT2.answerNonce);
    expect(answer).toEqual({ epk: KAT2.macEpk, nonce: KAT2.answerNonce.toString("base64"), ct: KAT2.answerCt });
    expect(openFromDevice(pairOf(0x41), answer, KAT.vault, KAT2.slot).toString("hex")).toBe(KAT2.deviceKek);
    expect(() => openFromDevice(pairOf(0x41), answer, KAT.vault, "s3")).toThrow();
    expect(() => openFromDevice(pairOf(0x42), answer, KAT.vault, KAT2.slot)).toThrow();
  });

  it("makes a passphrase slot's point from scrypt's bytes", () => {
    const pair = passphraseScalar(Buffer.from(KAT.passphraseKek, "hex"))!;
    expect(pair.priv.toString("hex")).toBe(KAT2.passScalar);
    expect(pair.pub.toString("base64")).toBe(KAT2.passPub);
  });

  it("MACs a device slot whole, its name included", () => {
    const slot = { id: KAT2.slot, kind: "device" as const, name: "Studio Mac", unlock: "login" as const, key: KAT2.devicePub, wrap: { alg: "ECDH-P256-A256GCM" as const, epk: KAT2.epk, nonce: KAT2.slotNonce.toString("base64"), ct: KAT2.deviceCt } };
    const doc = { version: 2 as const, vault: KAT.vault, dek: "k1", slots: [slot], entries: [{ id: KAT.entry, nonce: KAT.nonce.toString("base64"), ct: KAT2.entryCt }] };
    expect(indexMac(KAT.dek, doc, 7)).toBe(KAT2.mac);
    expect(indexMac(KAT.dek, { ...doc, slots: [{ ...slot, name: "Other Mac" }] }, 7)).not.toBe(KAT2.mac);
  });
});

let dir: string;
const vaultAt = (extra: Partial<ConstructorParameters<typeof Vault>[0]> = {}): Vault => new Vault({ dir, ...extra });
const fileOf = (): VaultFile => JSON.parse(readFileSync(join(dir, "vault.kosv"), "utf8")) as VaultFile;
const writeFile = (doc: VaultFile): void => writeFileSync(join(dir, "vault.kosv"), JSON.stringify(doc));
const flip = (b64: string): string => {
  const bytes = Buffer.from(b64, "base64");
  bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
  return bytes.toString("base64");
};

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "kos-vault-test-")), "secrets");
});

afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

async function twoSecrets(): Promise<Vault> {
  const vault = vaultAt();
  await vault.init();
  vault.add({ label: "GitHub", kind: "login", values: { username: "owner", password: "pw-correct-horse" } });
  vault.add({ label: "Stripe live", kind: "apikey", values: { token: "sk_live_0123456789abcdef" }, use: { http: { hosts: ["api.stripe.com"] } } });
  return vault;
}

describe("Vault", () => {
  it("starts absent, and init makes a key-file vault that opens by itself", async () => {
    const vault = vaultAt();
    expect(vault.status()).toEqual({ state: "absent", slots: [] });
    await vault.init();
    expect(vault.status()).toEqual({ state: "ready", slots: ["keyfile"] });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of ["vault.kosv", "key", "seq"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(vaultAt().status().state).toBe("ready");
    await expect(vault.init()).rejects.toMatchObject({ code: "exists" });
  });

  it("keeps the whole record sealed: no label, handle or value in the file", async () => {
    const vault = await twoSecrets();
    const text = readFileSync(join(dir, "vault.kosv"), "utf8");
    for (const needle of ["GitHub", "github", "owner", "pw-correct-horse", "sk_live", "stripe"]) expect(text).not.toContain(needle);
    expect(vault.list().map((s) => s.label)).toEqual(["GitHub", "Stripe live"]);
  });

  it("lists without values and decrypts one field on use", async () => {
    const vault = await twoSecrets();
    const [login] = vault.list();
    expect(login).toMatchObject({ label: "GitHub", kind: "login", fields: ["username", "password"], hint: "••••••••", version: 1 });
    expect(login!.handle).toMatch(/^github-[a-z0-9]{4}$/);
    expect(JSON.stringify(vault.list())).not.toContain("pw-correct-horse");
    expect(vault.value(login!.handle, "password")).toBe("pw-correct-horse");
    expect(vault.value("nope-0000", "password")).toBeUndefined();
  });

  it("edits with blank meaning unchanged, and bumps the version", async () => {
    const vault = await twoSecrets();
    const handle = vault.list()[0]!.handle;
    const meta = vault.update(handle, { label: "GitHub work", values: { password: "", username: "work" } });
    expect(meta).toMatchObject({ label: "GitHub work", version: 2 });
    expect(vault.value(handle, "password")).toBe("pw-correct-horse");
    expect(vault.value(handle, "username")).toBe("work");
    expect(() => vault.update(handle, { values: { token: "x" } })).toThrow(/no field token/);
  });

  it("deletes an entry and rotates the data key in one write", async () => {
    const vault = await twoSecrets();
    const [login, key] = vault.list();
    vault.remove(login!.handle);
    expect(fileOf().dek).toBe("k2");
    expect(fileOf().entries).toHaveLength(1);
    expect(vault.value(key!.handle, "token")).toBe("sk_live_0123456789abcdef");
    expect(vaultAt().list().map((s) => s.handle)).toEqual([key!.handle]);
    // The copy before held the deleted entry under a key that still opened it: gone too.
    expect(existsSync(join(dir, "vault.kosv.prev"))).toBe(false);
  });

  it("rotates the data key and the key file, and still opens", async () => {
    const vault = await twoSecrets();
    const before = readFileSync(join(dir, "key"), "utf8");
    vault.rotateDataKey();
    vault.rotateKeyfile();
    expect(readFileSync(join(dir, "key"), "utf8")).not.toBe(before);
    const again = vaultAt();
    expect(again.status().state).toBe("ready");
    expect(again.value(again.list()[1]!.handle, "token")).toBe("sk_live_0123456789abcdef");
  });

  it("sees a change another process made", async () => {
    const vault = await twoSecrets();
    const other = vaultAt();
    other.add({ label: "Notes", kind: "note", values: { text: "the long recovery phrase" } });
    expect(vault.list().map((s) => s.label)).toContain("Notes");
  });

  it("a passphrase locks it after every start until given", async () => {
    const vault = vaultAt();
    await vault.init({ passphrase: "a long passphrase" });
    expect(vault.status()).toEqual({ state: "ready", slots: ["passphrase"] });
    expect(existsSync(join(dir, "key"))).toBe(false);
    vault.add({ label: "GitHub", kind: "login", values: { password: "pw-correct-horse" } });
    const fresh = vaultAt();
    expect(fresh.status().state).toBe("locked");
    // No key file opens it: one put where the key goes, or one handed in as KOS_VAULT_KEY.
    writeFileSync(join(dir, "key"), `${range(0x90, 32).toString("base64")}\n`);
    expect(vaultAt().status().state).toBe("locked");
    expect(vaultAt({ envKey: range(0x90, 32).toString("base64") }).status().state).toBe("locked");
    expect(() => vaultAt().rotateDataKey()).toThrow(/locked/);
    expect(fresh.list()).toEqual([]);
    await expect(fresh.unlock("not it at all")).rejects.toMatchObject({ code: "passphrase" });
    await fresh.unlock("a long passphrase");
    expect(fresh.list()).toHaveLength(1);
    expect(await fresh.checkPassphrase("a long passphrase")).toBe(true);
    expect(await fresh.checkPassphrase("wrong one here")).toBe(false);
    // Rotation wraps the passphrase slot under the key it was opened with.
    fresh.remove(fresh.list()[0]!.handle);
    const third = vaultAt();
    await third.unlock("a long passphrase");
    expect(third.status().state).toBe("ready");
  }, 20_000);

  it("a passphrase added to a key-file vault becomes its only slot, and taking it off goes back", async () => {
    const vault = await twoSecrets();
    const oldKey = readFileSync(join(dir, "key"), "utf8");
    await vault.setPassphrase("added later on");
    expect(vault.status()).toEqual({ state: "ready", slots: ["passphrase"] });
    expect(existsSync(join(dir, "key"))).toBe(false);
    vault.rotateDataKey();
    // The old key file, put back, opens nothing.
    writeFileSync(join(dir, "key"), oldKey);
    const fresh = vaultAt();
    expect(fresh.status().state).toBe("locked");
    await fresh.unlock("added later on");
    expect(fresh.list()).toHaveLength(2);
    fresh.removePassphrase();
    expect(fresh.status()).toEqual({ state: "ready", slots: ["keyfile"] });
    const opened = vaultAt();
    expect(opened.status().state).toBe("ready");
    expect(opened.list()).toHaveLength(2);
    expect(() => opened.removePassphrase()).toThrow(/no passphrase/);
  }, 20_000);

  it("exports a copy only the passphrase opens", async () => {
    const vault = await twoSecrets();
    const out = join(dir, "..", "export");
    await vault.exportTo(join(dir, "..", "vault.export.kosv"), "export passphrase");
    const exported = JSON.parse(readFileSync(join(dir, "..", "vault.export.kosv"), "utf8")) as VaultFile;
    expect(exported.slots.map((s) => s.kind)).toEqual(["passphrase"]);
    // Put where a vault lives, with no key file beside it, it waits for the passphrase.
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, "vault.kosv"), JSON.stringify(exported), { mode: 0o600 });
    const opened = new Vault({ dir: out });
    expect(opened.status().state).toBe("locked");
    // A copy restored has no sequence records with it: the owner says it is the one first.
    await expect(opened.unlock("export passphrase")).rejects.toThrow(/trust-seq/);
    await expect(opened.trustSeq("not the passphrase")).rejects.toMatchObject({ code: "passphrase" });
    await opened.trustSeq("export passphrase");
    await opened.unlock("export passphrase");
    expect(opened.list()).toHaveLength(2);
  }, 20_000);

  it("wipes by crypto-erase: every file gone, nothing in memory", async () => {
    const vault = await twoSecrets();
    vault.rotateDataKey();
    await vault.wipe();
    for (const f of ["vault.kosv", "vault.kosv.prev", "key", "seq"]) expect(existsSync(join(dir, f))).toBe(false);
    expect(vault.status().state).toBe("absent");
    expect(vault.list()).toEqual([]);
  });

  it("takes the key from KOS_VAULT_KEY and writes no key file", async () => {
    const envKey = range(0x80, 32).toString("base64");
    const vault = vaultAt({ envKey });
    await vault.init();
    expect(existsSync(join(dir, "key"))).toBe(false);
    expect(vaultAt({ envKey }).status().state).toBe("ready");
    expect(vaultAt({ envKey: range(0x81, 32).toString("base64") }).status().state).toBe("locked");
  });

  it("refuses a vault folder inside the workspace, links resolved", async () => {
    const ws = join(dir, "..", "ws");
    mkdirSync(join(ws, "inner"), { recursive: true });
    await expect(new Vault({ dir: join(ws, "inner", "secrets"), workspace: ws }).init()).rejects.toMatchObject({ code: "refused" });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(ws, "inner"), join(dir, "..", "linked"));
    await expect(new Vault({ dir: join(dir, "..", "linked", "secrets"), workspace: ws }).init()).rejects.toMatchObject({ code: "refused" });
    await expect(new Vault({ dir, workspace: ws }).init()).resolves.toBeUndefined();
  });

  it("stays shut in the container unless the shared uid is allowed", async () => {
    await expect(vaultAt({ contained: true }).init()).rejects.toMatchObject({ code: "refused" });
    await twoSecrets();
    const shut = vaultAt({ contained: true });
    expect(shut.status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/KOS_VAULT_ALLOW_SHARED_UID/) });
    expect(vaultAt({ contained: true, allowSharedUid: true }).status().state).toBe("ready");
  });

  it("refuses bad records with reasons that repeat no value", async () => {
    const vault = vaultAt();
    await vault.init();
    expect(() => vault.add({ label: "", kind: "login", values: { password: "x" } })).toThrow(/label/);
    expect(() => vault.add({ label: "x", kind: "card", values: { number: "12" } })).toThrow(/12 to 19 digits/);
    expect(() => vault.add({ label: "x", kind: "login", values: {} })).toThrow(/needs its password/);
    expect(() => vault.add({ label: "x", kind: "apikey", values: { token: "t" }, use: { web: { origins: ["http://example.com"] } } })).toThrow(/https/);
    const card = vault.add({ label: "Visa", kind: "card", values: { number: "4242 4242 4242 4242", expiry: "4/29", cvc: "123" } });
    expect(vault.get(card)).toMatchObject({ hint: "•••• 4242", fields: ["number", "expiry", "cvc"] });
    expect(vault.value(card, "number")).toBe("4242424242424242");
    expect(vault.value(card, "expiry")).toBe("04/29");
  });
});

describe("Vault keys and files", () => {
  it("a passphrase added leaves no old key and no .prev that opens anything", async () => {
    const vault = await twoSecrets();
    const handle = vault.list()[0]!.handle;
    vault.update(handle, { label: "GitHub again" });
    expect(existsSync(join(dir, "vault.kosv.prev"))).toBe(true);
    const oldKey = readFileSync(join(dir, "key"), "utf8");
    await vault.setPassphrase("a long passphrase");
    expect(existsSync(join(dir, "vault.kosv.prev"))).toBe(false);
    expect(existsSync(join(dir, "key"))).toBe(false);
    expect(fileOf().dek).toBe("k2");
    // The old key put back opens neither the vault nor anything beside it.
    writeFileSync(join(dir, "key"), oldKey, { mode: 0o600 });
    expect(vaultAt().status().state).toBe("locked");
    const fresh = vaultAt();
    await fresh.unlock("a long passphrase");
    // Opened, it erases a key file no slot uses.
    expect(existsSync(join(dir, "key"))).toBe(false);
  }, 20_000);

  it("never erases a key file outside the lock, where another process may have just written it", async () => {
    const host = vaultAt();
    await host.init({ passphrase: "a long passphrase" });
    host.add({ label: "GitHub", kind: "login", values: { password: "pw-correct-horse" } });
    // The CLI, taking the passphrase off, has written its new key and not yet the vault.
    writeFileSync(join(dir, "key"), `${range(0x40, 32).toString("base64")}\n`, { mode: 0o600 });
    host.poll();
    expect(host.status().state).toBe("ready");
    expect(existsSync(join(dir, "key"))).toBe(true);
    // The CLI finishes under the lock; the host sees a key-file vault and the key stays.
    const cli = vaultAt();
    await cli.unlock("a long passphrase");
    cli.removePassphrase();
    expect(host.status().slots).toEqual(["keyfile"]);
    expect(existsSync(join(dir, "key"))).toBe(true);
  }, 20_000);

  it("keeps a change whose scrub index did not write, and says so; a locked vault says its index does not read", async () => {
    const vault = await twoSecrets();
    rmSync(join(dir, "scrub.kosi"));
    mkdirSync(join(dir, "scrub.kosi"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle = vault.add({ label: "Still saved", kind: "note", values: { text: "kept though the index failed" } });
    errors.mockRestore();
    expect(vaultAt().get(handle)).toBeDefined();
    expect(vault.status().problem).toMatch(/scrub index was not written/);
    rmSync(join(dir, "scrub.kosi"), { recursive: true });
    await vault.setPassphrase("a long passphrase");
    const { chmodSync } = await import("node:fs");
    chmodSync(join(dir, "scrub.kosi"), 0o644);
    const locked = vaultAt();
    expect(locked.status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/scrub index does not read/) });
  }, 20_000);

  it("refuses a key file or a folder others can read, and a key file that is a link", async () => {
    await twoSecrets();
    const { chmodSync, symlinkSync, renameSync } = await import("node:fs");
    chmodSync(join(dir, "key"), 0o644);
    expect(vaultAt().status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/can be read by others/) });
    chmodSync(join(dir, "key"), 0o600);
    chmodSync(dir, 0o755);
    expect(vaultAt().status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/can be read by others/) });
    chmodSync(dir, 0o700);
    renameSync(join(dir, "key"), join(dir, "..", "real-key"));
    symlinkSync(join(dir, "..", "real-key"), join(dir, "key"));
    expect(vaultAt().status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/is a link/) });
  });

  it("keeps a second sequence record outside the folder, and refuses when either is higher", async () => {
    const vault = await twoSecrets();
    const copy = `${dir}.seq`;
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(dir, "seq"), "utf8"));
    const old = readFileSync(join(dir, "vault.kosv"));
    const oldSeq = readFileSync(join(dir, "seq"));
    vault.add({ label: "Third", kind: "note", values: { text: "another long note" } });
    // An old copy and its in-folder record put back: the copy outside still says it is old.
    writeFileSync(join(dir, "vault.kosv"), old);
    writeFileSync(join(dir, "seq"), oldSeq);
    expect(vaultAt().status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/older than one KOS wrote/) });
  });

  it("says so when one sequence record is missing, and waits for the owner when both are", async () => {
    await twoSecrets();
    rmSync(join(dir, "seq"));
    expect(vaultAt().status()).toMatchObject({ state: "ready", problem: expect.stringMatching(/last sequence is missing/) });
    rmSync(`${dir}.seq`);
    const v = vaultAt();
    expect(v.status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/kos secrets trust-seq/) });
    // A file whose index does not match vouches for no sequence.
    const good = readFileSync(join(dir, "vault.kosv"), "utf8");
    const bad = JSON.parse(good) as VaultFile;
    bad.index.seq += 5;
    writeFile(bad);
    await expect(vaultAt().trustSeq()).rejects.toMatchObject({ code: "tampered" });
    writeFileSync(join(dir, "vault.kosv"), good);
    await v.trustSeq();
    expect(v.status()).toEqual({ state: "ready", slots: ["keyfile"] });
    expect(vaultAt().status()).toEqual({ state: "ready", slots: ["keyfile"] });
  });

  it("waits for another process's lock, and takes over one left by a process that is gone", async () => {
    const vault = await twoSecrets();
    writeFileSync(join(dir, "vault.lock"), "999999999\n");
    vault.add({ label: "After a stale lock", kind: "note", values: { text: "written anyway" } });
    expect(existsSync(join(dir, "vault.lock"))).toBe(false);
    for (const held of [`${process.pid}\n`, ""]) {
      // A live holder, and one whose lock does not read yet: both waited for.
      writeFileSync(join(dir, "vault.lock"), held);
      const start = Date.now();
      expect(() => vault.add({ label: "Held", kind: "note", values: { text: "never written" } })).toThrow(/another KOS process/);
      expect(Date.now() - start).toBeGreaterThanOrEqual(4_000);
      rmSync(join(dir, "vault.lock"));
    }
  }, 30_000);

  it("keeps every change when two processes write at once", async () => {
    const vault = await twoSecrets();
    const built = fileURLToPath(new URL("../../dist/secrets/vault.js", import.meta.url));
    const script = `import { Vault } from ${JSON.stringify(built)}; const v = new Vault({ dir: ${JSON.stringify(dir)} }); for (let i = 0; i < 15; i++) v.add({ label: "child " + i, kind: "note", values: { text: "from the child process " + i } });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const done = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
    for (let i = 0; i < 15; i++) {
      vault.add({ label: `parent ${i}`, kind: "note", values: { text: `from the parent process ${i}` } });
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await done, err).toBe(0);
    expect(vaultAt().list()).toHaveLength(32);
  }, 30_000);
});

describe("Vault tamper checks", () => {
  const tampered = (): Vault => {
    const fresh = vaultAt();
    expect(fresh.status().state).toBe("locked");
    expect(fresh.status().problem).toBeTruthy();
    expect(fresh.list()).toEqual([]);
    return fresh;
  };

  it.each([
    ["a flipped byte in an entry's ciphertext", (d: VaultFile) => void (d.entries[0]!.ct = flip(d.entries[0]!.ct))],
    ["a flipped byte in an entry's nonce", (d: VaultFile) => void (d.entries[1]!.nonce = flip(d.entries[1]!.nonce))],
    ["a flipped byte in the slot", (d: VaultFile) => void (d.slots[0]!.wrap.ct = flip(d.slots[0]!.wrap.ct))],
    ["a flipped byte in the index MAC", (d: VaultFile) => void (d.index.mac = flip(d.index.mac))],
    ["a changed sequence number", (d: VaultFile) => void (d.index.seq += 1)],
    ["a changed vault id", (d: VaultFile) => void (d.vault = "v_0000000000000000")],
    ["entries swapped between ids", (d: VaultFile) => {
      const [a, b] = d.entries;
      [a!.ct, b!.ct, a!.nonce, b!.nonce] = [b!.ct, a!.ct, b!.nonce, a!.nonce];
    }],
    ["entries reordered", (d: VaultFile) => void d.entries.reverse()],
    ["an entry dropped", (d: VaultFile) => void d.entries.pop()],
    ["an entry duplicated under a new id", (d: VaultFile) => void d.entries.push({ ...d.entries[1]!, id: "e_ffffffffffffffff" })],
  ])("refuses %s", async (_what, edit) => {
    await twoSecrets();
    const doc = fileOf();
    edit(doc);
    writeFile(doc);
    tampered();
  });

  it("refuses one entry pasted back from the copy before", async () => {
    const vault = await twoSecrets();
    const handle = vault.list()[0]!.handle;
    vault.update(handle, { values: { password: "pw-the-new-one" } });
    const prev = JSON.parse(readFileSync(join(dir, "vault.kosv.prev"), "utf8")) as VaultFile;
    const doc = fileOf();
    const i = doc.entries.findIndex((e) => prev.entries.some((p) => p.id === e.id && p.ct !== e.ct));
    expect(i).toBeGreaterThanOrEqual(0);
    const old = prev.entries.find((p) => p.id === doc.entries[i]!.id)!;
    doc.entries[i] = { ...old };
    writeFile(doc);
    tampered();
  });

  it("refuses an older copy put back", async () => {
    const vault = await twoSecrets();
    const old = readFileSync(join(dir, "vault.kosv"));
    vault.add({ label: "Third", kind: "note", values: { text: "another long note" } });
    writeFileSync(join(dir, "vault.kosv"), old);
    expect(tampered().status().problem).toMatch(/older than one KOS wrote/);
  });

  it("refuses to change a vault it could not verify", async () => {
    await twoSecrets();
    const doc = fileOf();
    doc.entries.pop();
    writeFile(doc);
    expect(() => vaultAt().add({ label: "x", kind: "note", values: { text: "nothing here" } })).toThrow(VaultError);
  });
});

/** A version 1 vault as KOS wrote it before device slots: a key-file slot, or a passphrase alone. */
async function v1Vault(passphrase?: string): Promise<{ vault: string; token: string }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dek = range(0x00, 32);
  const vault = "v_00000000000000aa";
  const nonce = range(0x70, 12);
  const wrap = (kek: Buffer) => ({ alg: "A256GCM" as const, nonce: nonce.toString("base64"), ct: seal(kek, nonce, dek, slotAad(vault, "s1", "k1", 1)).toString("base64") });
  let slot: VaultFile["slots"][number];
  if (passphrase) {
    const salt = range(0x40, 16);
    slot = { id: "s1", kind: "passphrase", kdf: { alg: "scrypt", N: 131_072, r: 8, p: 1, salt: salt.toString("base64") }, wrap: wrap(await passphraseKek(passphrase, salt)) };
  } else {
    const key = range(0x20, 32);
    writeFileSync(join(dir, "key"), `${key.toString("base64")}\n`, { mode: 0o600 });
    slot = { id: "s1", kind: "keyfile", wrap: wrap(key) };
  }
  const token = "sk_live_from_version_one_0123";
  const record = {
    handle: "stripe-ab12",
    label: "Stripe",
    kind: "apikey",
    values: { token },
    use: { web: { origins: [], frames: [] }, apps: [], http: { hosts: ["api.stripe.com"] } },
    policy: { ask: "always", unattended: false, chats: null, grants: [] },
    hint: "••••0123",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  };
  const entryNonce = range(0x60, 12);
  const entries = [{ id: "e_00000000000000a1", nonce: entryNonce.toString("base64"), ct: seal(dek, entryNonce, Buffer.from(JSON.stringify(record)), entryAad(vault, "e_00000000000000a1", "k1", 1)).toString("base64") }];
  const doc = { format: "kos-vault" as const, version: 1 as const, vault, dek: "k1", slots: [slot], entries };
  writeFileSync(join(dir, "vault.kosv"), JSON.stringify({ ...doc, index: { seq: 3, mac: indexMac(dek, doc, 3) } }), { mode: 0o600 });
  for (const seq of [join(dir, "seq"), `${dir}.seq`]) writeFileSync(seq, `${vault} 3\n`, { mode: 0o600 });
  return { vault, token };
}

/** A KOS for Mac stood in for by a software P-256 key: it answers a device slot's key, as the Secure Enclave would. */
function fakeMac(pair: P256Pair = p256Pair()): { key: Buffer; unwrap: DeviceUnwrapper; asked: () => number } {
  let asked = 0;
  return {
    key: pair.pub,
    asked: () => asked,
    unwrap: async (req) => {
      asked++;
      if (req.key !== pair.pub.toString("base64")) throw new Error("this Mac holds another key");
      return keyFrom(pair.priv, pair.pub, Buffer.from(req.epk, "base64"), deviceInfo(req.vault, req.slot));
    },
  };
}

const PASS = "a long passphrase";

describe("Vault version 1", () => {
  it("reads a key-file vault as it is, and its first change makes it version 2", async () => {
    const { token } = await v1Vault();
    const vault = vaultAt();
    expect(vault.status()).toEqual({ state: "ready", slots: ["keyfile"] });
    expect(vault.value("stripe-ab12", "token")).toBe(token);
    // Reading writes nothing.
    expect(fileOf().version).toBe(1);
    vault.add({ label: "GitHub", kind: "login", values: { password: "pw-correct-horse" } });
    const doc = fileOf();
    expect(doc.version).toBe(2);
    expect(doc.dek).toBe("k2");
    // The version 1 copy under the old data key is gone: .prev is the reseal's, from before the add.
    expect((JSON.parse(readFileSync(join(dir, "vault.kosv.prev"), "utf8")) as VaultFile).version).toBe(2);
    const fresh = vaultAt();
    expect(fresh.status().state).toBe("ready");
    expect(fresh.value("stripe-ab12", "token")).toBe(token);
    expect(fresh.list()).toHaveLength(2);
  });

  it("opens a passphrase vault with its passphrase, and moves the passphrase slot to version 2 on the first change", async () => {
    const { token } = await v1Vault(PASS);
    const vault = vaultAt();
    expect(vault.status().state).toBe("locked");
    await expect(vault.unlock("not the passphrase")).rejects.toMatchObject({ code: "passphrase" });
    await vault.unlock(PASS);
    expect(vault.value("stripe-ab12", "token")).toBe(token);
    expect(fileOf().version).toBe(1);
    vault.rotateDataKey();
    const slot = fileOf().slots[0]!;
    expect(fileOf().version).toBe(2);
    expect(slot).toMatchObject({ kind: "passphrase", kdf: { salt: range(0x40, 16).toString("base64") }, wrap: { alg: "ECDH-P256-A256GCM" } });
    const fresh = vaultAt();
    expect(fresh.status().state).toBe("locked");
    await fresh.unlock(PASS);
    expect(fresh.value("stripe-ab12", "token")).toBe(token);
    // Now a Mac can be added beside it.
    const mac = fakeMac();
    await fresh.addDeviceSlot("Studio Mac", mac.key, mac.unwrap);
    const later = vaultAt();
    expect(await later.unlockWithDevice(mac.unwrap)).toBe(true);
    expect(later.value("stripe-ab12", "token")).toBe(token);
  }, 30_000);

  it("refuses a device slot in a version 1 file", async () => {
    await v1Vault();
    const doc = fileOf();
    doc.slots.push({ id: "s2", kind: "device", name: "Mac", unlock: "login", key: KAT2.devicePub, wrap: { alg: "ECDH-P256-A256GCM", epk: KAT2.epk, nonce: "AAAAAAAAAAAAAAAA", ct: KAT2.deviceCt } });
    writeFile(doc);
    expect(vaultAt().status()).toMatchObject({ state: "locked", problem: expect.stringMatching(/malformed/) });
  });
});

describe("Vault device slots", () => {
  async function withMac(): Promise<{ vault: Vault; mac: ReturnType<typeof fakeMac>; handle: string }> {
    const vault = vaultAt();
    await vault.init({ passphrase: PASS });
    const handle = vault.add({ label: "OpenAI", kind: "apikey", values: { token: "sk-proj-device-slot-0123456789" } });
    const mac = fakeMac();
    expect(await vault.addDeviceSlot("Studio Mac", mac.key, mac.unwrap)).toEqual({ id: "s2", name: "Studio Mac" });
    return { vault, mac, handle };
  }

  it("opens after a restart by asking the Mac, with no passphrase typed", async () => {
    const { mac, handle } = await withMac();
    const fresh = vaultAt();
    expect(fresh.status()).toEqual({ state: "locked", slots: ["passphrase", "device"], devices: [{ id: "s2", name: "Studio Mac" }] });
    expect(await fresh.unlockWithDevice(mac.unwrap)).toBe(true);
    expect(fresh.status().state).toBe("ready");
    expect(fresh.value(handle, "token")).toBe("sk-proj-device-slot-0123456789");
    // Nothing on disk opens it: no key file.
    expect(existsSync(join(dir, "key"))).toBe(false);
  }, 30_000);

  it("stays locked with the reason when the Mac cannot open it, and the passphrase still does", async () => {
    await withMac();
    const fresh = vaultAt();
    expect(await fresh.unlockWithDevice(fakeMac().unwrap)).toBe(false);
    expect(fresh.status()).toMatchObject({ state: "locked", atLogin: expect.stringMatching(/Studio Mac: this Mac holds another key.*passphrase still opens it/) });
    const offline: DeviceUnwrapper = async () => {
      throw new Error("the device is offline");
    };
    expect(await fresh.unlockWithDevice(offline)).toBe(false);
    expect(fresh.status().atLogin).toMatch(/offline/);
    await fresh.unlock(PASS);
    expect(fresh.status()).toEqual({ state: "ready", slots: ["passphrase", "device"], devices: [{ id: "s2", name: "Studio Mac" }] });
  }, 30_000);

  it("needs a passphrase beside it, a Mac that proves its key, and one slot per Mac", async () => {
    const plain = vaultAt();
    await plain.init();
    const mac = fakeMac();
    await expect(plain.addDeviceSlot("Mac", mac.key, mac.unwrap)).rejects.toThrow(/passphrase first/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.seq`, { force: true });
    const vault = vaultAt();
    await vault.init({ passphrase: PASS });
    const liar = fakeMac();
    await expect(vault.addDeviceSlot("Mac", mac.key, liar.unwrap)).rejects.toThrow(/another key/);
    const wrongAnswer: DeviceUnwrapper = async () => range(0x00, 32);
    await expect(vault.addDeviceSlot("Mac", mac.key, wrongAnswer)).rejects.toMatchObject({ code: "refused" });
    expect(fileOf().slots.map((s) => s.kind)).toEqual(["passphrase"]);
    await vault.addDeviceSlot("Mac", mac.key, mac.unwrap);
    await expect(vault.addDeviceSlot("Mac", mac.key, mac.unwrap)).rejects.toMatchObject({ code: "exists" });
    await expect(vault.addDeviceSlot("Mac", Buffer.alloc(65, 4), mac.unwrap)).rejects.toMatchObject({ code: "invalid" });
    expect(() => vault.removePassphrase()).toThrow(/unlock at login first/);
  }, 30_000);

  it("keeps working while the Mac opened it: changes, deletes and a new passphrase", async () => {
    const { mac, handle } = await withMac();
    const vault = vaultAt();
    await vault.unlockWithDevice(mac.unwrap);
    vault.update(handle, { values: { token: "sk-proj-changed-0123456789" } });
    // A delete rotates the data key: every slot is wrapped again, the Mac's included.
    const other = vault.add({ label: "Note", kind: "note", values: { text: "a note to delete" } });
    vault.remove(other);
    expect(vault.status().state).toBe("ready");
    await vault.setPassphrase("a different passphrase");
    expect(vault.status()).toMatchObject({ state: "ready", devices: [{ id: "s2", name: "Studio Mac" }] });
    const fresh = vaultAt();
    expect(await fresh.unlockWithDevice(mac.unwrap)).toBe(true);
    expect(fresh.value(handle, "token")).toBe("sk-proj-changed-0123456789");
    const typed = vaultAt();
    await expect(typed.unlock(PASS)).rejects.toMatchObject({ code: "passphrase" });
    await typed.unlock("a different passphrase");
    expect(typed.list()).toHaveLength(1);
  }, 60_000);

  it("follows a change another process made with the Mac's slot wrapped again", async () => {
    const { mac } = await withMac();
    const host = vaultAt();
    await host.unlockWithDevice(mac.unwrap);
    const cli = vaultAt();
    await cli.unlock(PASS);
    cli.rotateDataKey();
    // The CLI sealed the Mac's slot to a new ephemeral point: the host's key no longer opens it, so it asks again.
    expect(host.status().state).toBe("locked");
    expect(await host.unlockWithDevice(mac.unwrap)).toBe(true);
    expect(mac.asked()).toBe(3);
  }, 30_000);

  it("takes a Mac off with the passphrase: a new data key, and that Mac opens nothing after", async () => {
    const { mac, handle } = await withMac();
    const vault = vaultAt();
    await vault.unlockWithDevice(mac.unwrap);
    const before = fileOf().dek;
    await expect(vault.removeDeviceSlot("s2", "not the passphrase")).rejects.toMatchObject({ code: "passphrase" });
    await expect(vault.removeDeviceSlot("s9", PASS)).rejects.toMatchObject({ code: "not-found" });
    await vault.removeDeviceSlot("s2", PASS);
    expect(vault.status()).toEqual({ state: "ready", slots: ["passphrase"] });
    expect(fileOf().dek).not.toBe(before);
    expect(vault.value(handle, "token")).toBe("sk-proj-device-slot-0123456789");
    const fresh = vaultAt();
    expect(await fresh.unlockWithDevice(mac.unwrap)).toBe(false);
    expect(fresh.status().state).toBe("locked");
  }, 30_000);

  it("refuses a device slot renamed or re-pointed in the file", async () => {
    await withMac();
    const renamed = fileOf();
    const slot = renamed.slots.find((s) => s.kind === "device")! as Extract<VaultFile["slots"][number], { kind: "device" }>;
    slot.name = "Someone else's Mac";
    writeFile(renamed);
    expect(vaultAt().status().state).toBe("locked");
    const fresh = vaultAt();
    await expect(fresh.unlock(PASS)).rejects.toMatchObject({ code: "tampered" });
  }, 30_000);

  it("exports a copy with the passphrase slot alone", async () => {
    await withMac();
    const vault = vaultAt();
    await vault.unlock(PASS);
    await vault.exportTo(join(dir, "..", "copy.kosv"), PASS);
    const copy = JSON.parse(readFileSync(join(dir, "..", "copy.kosv"), "utf8")) as VaultFile;
    expect(copy.version).toBe(2);
    expect(copy.slots.map((s) => s.kind)).toEqual(["passphrase"]);
  }, 30_000);
});
