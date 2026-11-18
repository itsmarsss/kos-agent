import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entryAad, indexKey, indexMac, passphraseKek, seal, slotAad, unseal, Vault, VaultError, type VaultFile } from "./vault.js";

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

describe("vault format vectors", () => {
  it("seals an entry under its AAD", () => {
    const sealed = seal(KAT.dek, KAT.nonce, Buffer.from(KAT.record), entryAad(KAT.vault, KAT.entry, "k1"));
    expect(sealed.toString("base64")).toBe(KAT.entryCt);
    expect(unseal(KAT.dek, KAT.nonce, sealed, entryAad(KAT.vault, KAT.entry, "k1")).toString()).toBe(KAT.record);
  });

  it("refuses an entry read under another id, vault or data key", () => {
    const sealed = Buffer.from(KAT.entryCt, "base64");
    expect(() => unseal(KAT.dek, KAT.nonce, sealed, entryAad(KAT.vault, "e_00000000000000b2", "k1"))).toThrow();
    expect(() => unseal(KAT.dek, KAT.nonce, sealed, entryAad("v_fedcba9876543210", KAT.entry, "k1"))).toThrow();
    expect(() => unseal(KAT.dek, KAT.nonce, sealed, entryAad(KAT.vault, KAT.entry, "k2"))).toThrow();
  });

  it("wraps the data key in a slot", () => {
    expect(seal(KAT.kek, KAT.slotNonce, KAT.dek, slotAad(KAT.vault, "s1", "k1")).toString("base64")).toBe(KAT.slotCt);
  });

  it("derives the index key and MACs the slots and each entry's bytes", () => {
    expect(indexKey(KAT.dek).toString("hex")).toBe(KAT.indexKey);
    const doc = {
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
    opened.trustSeq();
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
    v.trustSeq();
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
