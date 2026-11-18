import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SecretFieldName, SecretKind, SecretPolicy, SecretSummary, SecretUse, SecretValues, VaultSlotKind } from "@kos/shared";

import { checkPolicy, checkUse, checkValues, hintOf, labelOf, originAllowed, scannedOf, slugOf, type ScannedValue } from "./records.js";

/**
 * The owner's secrets at rest: one encrypted file, docs/secrets.md.
 *
 * Envelope encryption with key slots, as LUKS does it. Every record is
 * sealed whole (AES-256-GCM) under one data key; the data key is wrapped
 * once per slot, under the key file's 32 bytes or under scrypt of a
 * passphrase. An HMAC over the entry ids and a sequence number, under a key
 * derived from the data key, catches an entry dropped, added or put back
 * from an older copy.
 *
 * Values are decrypted one entry at a time, into a Buffer that is zeroed
 * once the field is read. The string a caller is handed cannot be wiped:
 * that is JavaScript's limit, not this file's.
 */

export const VAULT_FORMAT = "kos-vault";
export const VAULT_VERSION = 1;
const TAG = "kos-vault/1";

/** scrypt as the format fixes it: N = 2^17, r = 8, p = 1, 32 bytes out. */
export const SCRYPT = { N: 131_072, r: 8, p: 1 } as const;
/** Twice what N and r need (128 * N * r), so node does not refuse it. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const VAULT_FILE = "vault.kosv";
const KEY_FILE = "key";
/** The highest sequence number this machine has seen, so an older copy put back is refused. */
const SEQ_FILE = "seq";

interface Wrap {
  alg: "A256GCM";
  nonce: string;
  ct: string;
}

interface KeyfileSlot {
  id: string;
  kind: "keyfile";
  wrap: Wrap;
}

interface PassphraseSlot {
  id: string;
  kind: "passphrase";
  kdf: { alg: "scrypt"; N: number; r: number; p: number; salt: string };
  wrap: Wrap;
}

type Slot = KeyfileSlot | PassphraseSlot;

interface Entry {
  id: string;
  nonce: string;
  ct: string;
}

export interface VaultFile {
  format: typeof VAULT_FORMAT;
  version: typeof VAULT_VERSION;
  vault: string;
  dek: string;
  slots: Slot[];
  entries: Entry[];
  index: { seq: number; mac: string };
}

/** One secret as it is sealed: everything about it, values included. */
export interface SecretRecord {
  handle: string;
  label: string;
  kind: SecretKind;
  values: SecretValues;
  use: SecretUse;
  policy: SecretPolicy;
  hint: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** A record without its values: what the vault keeps in memory between uses. */
export type SecretMeta = Omit<SecretSummary, "source" | "lastUsedAt"> & { version: number };

export type VaultErrorCode = "absent" | "locked" | "exists" | "tampered" | "refused" | "passphrase" | "not-found" | "invalid";

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

// The format's primitives, exported for the known-answer vectors.

export function entryAad(vault: string, entryId: string, dekId: string): Buffer {
  return Buffer.from(`${TAG}|${vault}|${entryId}|${dekId}`, "utf8");
}

export function slotAad(vault: string, slotId: string, dekId: string): Buffer {
  return Buffer.from(`${TAG}|slot|${vault}|${slotId}|${dekId}`, "utf8");
}

/** AES-256-GCM: the ciphertext with its 16-byte tag after it. */
export function seal(key: Buffer, nonce: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** The plaintext, or a throw when any byte of key, nonce, ciphertext, tag or AAD is not what was sealed. */
export function unseal(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < 16 || nonce.length !== 12) throw new Error("malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

export function indexKey(dek: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), `${TAG} index`, 32));
}

export function indexMac(dek: Buffer, vault: string, seq: number, entryIds: readonly string[]): string {
  const key = indexKey(dek);
  try {
    return createHmac("sha256", key).update(`${TAG}|${vault}|${seq}|${[...entryIds].sort().join(",")}`).digest("base64");
  } finally {
    key.fill(0);
  }
}

export function passphraseKek(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number } = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize("NFC"), salt, 32, { ...params, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const b64 = (b: Buffer): string => b.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");
const hex = (n: number): string => randomBytes(n).toString("hex");

function wrapDek(kek: Buffer, dek: Buffer, vault: string, slotId: string, dekId: string): Wrap {
  const nonce = randomBytes(12);
  return { alg: "A256GCM", nonce: b64(nonce), ct: b64(seal(kek, nonce, dek, slotAad(vault, slotId, dekId))) };
}

/** The data key a slot wraps, or undefined when this key-encryption key is not the slot's. */
function unwrapDek(kek: Buffer, slot: Slot, vault: string, dekId: string): Buffer | undefined {
  try {
    if (slot.wrap.alg !== "A256GCM") return undefined;
    const dek = unseal(kek, unb64(slot.wrap.nonce), unb64(slot.wrap.ct), slotAad(vault, slot.id, dekId));
    return dek.length === 32 ? dek : undefined;
  } catch {
    return undefined;
  }
}

const ENTRY_ID = /^e_[0-9a-f]{16}$/;
const VAULT_ID = /^v_[0-9a-f]{16}$/;
const DEK_ID = /^k[1-9][0-9]*$/;

/** The file as JSON of the right shape, or why not. Nothing is trusted until the MAC and every entry check. */
function parseVault(text: string): VaultFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new VaultError("tampered", "the vault file is not JSON");
  }
  const v = doc as VaultFile;
  const shaped =
    v !== null &&
    typeof v === "object" &&
    v.format === VAULT_FORMAT &&
    v.version === VAULT_VERSION &&
    typeof v.vault === "string" &&
    VAULT_ID.test(v.vault) &&
    typeof v.dek === "string" &&
    DEK_ID.test(v.dek) &&
    Array.isArray(v.slots) &&
    Array.isArray(v.entries) &&
    v.index !== null &&
    typeof v.index === "object" &&
    Number.isSafeInteger(v.index.seq) &&
    typeof v.index.mac === "string";
  if (!shaped) throw new VaultError("tampered", "the vault file is not a kos-vault version 1");
  for (const s of v.slots) {
    const ok = s && typeof s.id === "string" && s.wrap && typeof s.wrap.nonce === "string" && typeof s.wrap.ct === "string";
    const kdf = s.kind === "passphrase" ? s.kdf : undefined;
    if (!ok || (s.kind !== "keyfile" && s.kind !== "passphrase") || (s.kind === "passphrase" && (!kdf || kdf.alg !== "scrypt" || typeof kdf.salt !== "string"))) {
      throw new VaultError("tampered", "a key slot in the vault file is malformed");
    }
  }
  // Stored in id order, so an entry moved is as plain as one changed.
  for (let i = 0; i < v.entries.length; i++) {
    const e = v.entries[i]!;
    if (!e || typeof e.id !== "string" || !ENTRY_ID.test(e.id) || typeof e.nonce !== "string" || typeof e.ct !== "string") {
      throw new VaultError("tampered", "an entry in the vault file is malformed");
    }
    if (i > 0 && v.entries[i - 1]!.id >= e.id) throw new VaultError("tampered", "the vault's entries are out of order");
  }
  return v;
}

/** Write `data` so the file is either all old or all new: a temp file, fsynced, renamed over. */
function writeAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every filesystem lets a directory be synced; the rename is still atomic.
  }
}

/** Overwrite a file with random bytes, sync it, then unlink it. */
function shred(path: string): void {
  if (!existsSync(path)) return;
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, randomBytes(Math.max(size, 32)), 0, Math.max(size, 32), 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    unlinkSync(path);
  }
}

/** Keep the key file out of Time Machine, by the attribute tmutil sets; no tmutil, so no prompt. */
function excludeFromBackup(path: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("xattr", ["-w", "com.apple.metadata:com_apple_backup_excludeItem", "com.apple.backupd", path], { stdio: "ignore", timeout: 5_000 });
  } catch {
    // Best effort: a key file in a backup is still useless without the vault, which is never in the workspace.
  }
}

export interface VaultOptions {
  dir: string;
  /** KOS_VAULT_KEY: the key file's 32 bytes as base64, for the container, where there is no key file. */
  envKey?: string;
  /** Running in the container, where tools still share KOS's uid. */
  contained?: boolean;
  /** KOS_VAULT_ALLOW_SHARED_UID=1: open the vault in the container anyway. */
  allowSharedUid?: boolean;
  now?: () => number;
}

/** Where the vault lives: KOS_VAULT_DIR, else ~/.kos/secrets. Never in the workspace. */
export function vaultDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KOS_VAULT_DIR?.trim() || join(homedir(), ".kos", "secrets");
}

interface Held {
  entry: string;
  meta: SecretMeta;
}

export interface NewSecret {
  label: string;
  kind: SecretKind;
  values: SecretValues;
  use?: unknown;
  policy?: unknown;
}

export interface SecretPatch {
  label?: string;
  values?: SecretValues;
  use?: unknown;
  policy?: unknown;
}

/** What unlocked the data key, kept so a change made elsewhere (a rotate from the CLI) can be followed. */
interface Opener {
  kind: VaultSlotKind;
  kek: Buffer;
}

export class Vault {
  readonly dir: string;
  private readonly file: string;
  private readonly prev: string;
  private readonly keyPath: string;
  private readonly seqPath: string;
  private readonly now: () => number;

  private doc: VaultFile | undefined;
  /** mtime, size and inode of the file last read, so a change made by another process is noticed. */
  private stamp = "";
  private dek: Buffer | undefined;
  private opener: Opener | undefined;
  private problem: string | undefined;
  private held = new Map<string, Held>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: VaultOptions) {
    this.dir = options.dir;
    this.file = join(this.dir, VAULT_FILE);
    this.prev = `${this.file}.prev`;
    this.keyPath = join(this.dir, KEY_FILE);
    this.seqPath = join(this.dir, SEQ_FILE);
    this.now = options.now ?? Date.now;
    this.refresh();
  }

  static fromEnv(env: NodeJS.ProcessEnv, contained: boolean): Vault {
    return new Vault({
      dir: vaultDir(env),
      ...(env.KOS_VAULT_KEY?.trim() ? { envKey: env.KOS_VAULT_KEY.trim() } : {}),
      contained,
      allowSharedUid: env.KOS_VAULT_ALLOW_SHARED_UID === "1",
    });
  }

  /** Told after every change, here or in the file: the scrubber rebuilds from it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): { state: "absent" | "locked" | "ready"; slots: VaultSlotKind[]; problem?: string } {
    this.refresh();
    // A file that is there but will not read is a vault shut, not one missing: init must not write over it.
    if (!this.doc) return { state: this.stamp ? "locked" : "absent", slots: [], ...(this.problem ? { problem: this.problem } : {}) };
    const slots = [...new Set(this.doc.slots.map((s) => s.kind))];
    return { state: this.dek ? "ready" : "locked", slots, ...(this.problem ? { problem: this.problem } : {}) };
  }

  hasPassphrase(): boolean {
    this.refresh();
    return this.doc?.slots.some((s) => s.kind === "passphrase") === true;
  }

  // Reading

  list(): SecretMeta[] {
    this.refresh();
    return [...this.held.values()].map((h) => h.meta).sort((a, b) => a.label.localeCompare(b.label) || a.handle.localeCompare(b.handle));
  }

  get(handle: string): SecretMeta | undefined {
    this.refresh();
    return this.held.get(handle)?.meta;
  }

  /**
   * One field's value, decrypted from its entry alone; the decrypted buffer
   * is zeroed before this returns. Undefined when there is no such secret
   * or field, or the vault is not open.
   */
  value(handle: string, field: SecretFieldName): string | undefined {
    const got = this.withRecord(handle, (record) => record.values[field]);
    return typeof got === "string" ? got : undefined;
  }

  /** A field as the owner reveals it: a billing address as its object. */
  reveal(handle: string, field: SecretFieldName): SecretValues[SecretFieldName] | undefined {
    return this.withRecord(handle, (record) => record.values[field]);
  }

  /** Every value the scrubber looks for, by `<handle>.<field>`, decrypted one entry at a time. */
  scanned(): ScannedValue[] {
    this.refresh();
    const out: ScannedValue[] = [];
    for (const handle of this.held.keys()) this.withRecord(handle, (record) => out.push(...scannedOf(record)));
    return out;
  }

  private withRecord<T>(handle: string, read: (record: SecretRecord) => T): T | undefined {
    this.refresh();
    const held = this.held.get(handle);
    if (!held || !this.dek || !this.doc) return undefined;
    const entry = this.doc.entries.find((e) => e.id === held.entry);
    if (!entry) return undefined;
    const plain = this.openEntry(this.doc, this.dek, entry);
    try {
      return read(JSON.parse(plain.toString("utf8")) as SecretRecord);
    } finally {
      plain.fill(0);
    }
  }

  // Opening

  /** The passphrase slot opened: the vault is ready until the host stops. */
  async unlock(passphrase: string): Promise<void> {
    this.refresh();
    const doc = this.present();
    this.refuseShared();
    const opener = await this.passphraseOpener(doc, passphrase);
    this.dek?.fill(0);
    this.opener?.kek.fill(0);
    this.opener = opener;
    this.dek = undefined;
    this.problem = undefined;
    this.stamp = "";
    this.refresh();
    if (!this.dek) throw new VaultError("tampered", this.problem ?? "the vault would not open");
  }

  /** Whether `passphrase` opens the passphrase slot, for a reveal's step-up. */
  async checkPassphrase(passphrase: string): Promise<boolean> {
    this.refresh();
    const doc = this.present();
    try {
      (await this.passphraseOpener(doc, passphrase)).kek.fill(0);
      return true;
    } catch (err) {
      if (err instanceof VaultError && err.code === "passphrase") return false;
      throw err;
    }
  }

  private async passphraseOpener(doc: VaultFile, passphrase: string): Promise<Opener> {
    const slot = doc.slots.find((s): s is PassphraseSlot => s.kind === "passphrase");
    if (!slot) throw new VaultError("invalid", "this vault has no passphrase");
    const { N, r, p, salt } = slot.kdf;
    const kek = await passphraseKek(passphrase, unb64(salt), { N, r, p });
    const dek = unwrapDek(kek, slot, doc.vault, doc.dek);
    if (!dek) {
      kek.fill(0);
      throw new VaultError("passphrase", "that is not the vault's passphrase");
    }
    dek.fill(0);
    return { kind: "passphrase", kek };
  }

  /** Create the vault: a key-file slot always, a passphrase slot when one is given. */
  async init(options: { passphrase?: string } = {}): Promise<void> {
    this.refresh();
    if (this.doc || existsSync(this.file)) throw new VaultError("exists", "there is a vault already");
    this.refuseShared();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const key = this.keyBytes() ?? this.makeKey();
    const dek = randomBytes(32);
    const vault = `v_${hex(8)}`;
    const dekId = "k1";
    const slots: Slot[] = [{ id: "s1", kind: "keyfile", wrap: wrapDek(key, dek, vault, "s1", dekId) }];
    let opener: Opener = { kind: "keyfile", kek: key };
    if (options.passphrase !== undefined) {
      const slot = await this.passphraseSlot(options.passphrase, dek, vault, "s2", dekId);
      slots.push(slot.slot);
      key.fill(0);
      opener = { kind: "passphrase", kek: slot.kek };
    }
    this.write({ format: VAULT_FORMAT, version: VAULT_VERSION, vault, dek: dekId, slots, entries: [], index: { seq: 0, mac: "" } }, dek, opener);
  }

  private async passphraseSlot(passphrase: string, dek: Buffer, vault: string, id: string, dekId: string): Promise<{ slot: PassphraseSlot; kek: Buffer }> {
    if (passphrase.length < 8) throw new VaultError("invalid", "a passphrase is at least 8 characters");
    const salt = randomBytes(16);
    const kek = await passphraseKek(passphrase, salt);
    return { slot: { id, kind: "passphrase", kdf: { alg: "scrypt", ...SCRYPT, salt: b64(salt) }, wrap: wrapDek(kek, dek, vault, id, dekId) }, kek };
  }

  // Changing

  add(input: NewSecret): string {
    const { doc, dek } = this.ready();
    const label = labelOf(input.label);
    const kind = input.kind;
    const values = checkValues(kind, input.values, undefined);
    const now = this.now();
    let handle: string;
    do handle = `${slugOf(label)}-${randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, "0").slice(-4)}`;
    while (this.held.has(handle));
    const record: SecretRecord = {
      handle,
      label,
      kind,
      values,
      use: checkUse(input.use),
      policy: checkPolicy(input.policy, undefined),
      hint: hintOf(kind, values),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    let id: string;
    do id = `e_${hex(8)}`;
    while (doc.entries.some((e) => e.id === id));
    const entries = [...doc.entries, this.sealEntry(doc.vault, doc.dek, dek, id, record)].sort((a, b) => (a.id < b.id ? -1 : 1));
    this.write({ ...doc, entries }, dek, this.opener!);
    return handle;
  }

  update(handle: string, patch: SecretPatch): SecretMeta {
    return this.change(handle, (record) => {
      const values = patch.values === undefined ? record.values : checkValues(record.kind, patch.values, record.values);
      const use = patch.use !== undefined ? checkUse(patch.use) : record.use;
      const policy = patch.policy !== undefined ? checkPolicy(patch.policy, record.policy) : record.policy;
      return {
        ...record,
        ...(patch.label !== undefined ? { label: labelOf(patch.label) } : {}),
        values,
        use,
        // A site no longer allowed keeps no grant on it.
        policy: { ...policy, grants: policy.grants.filter((g) => originAllowed(g.origin, use.web.origins)) },
        hint: hintOf(record.kind, values),
      };
    });
  }

  /** A remembered grant taken back. */
  revokeGrant(handle: string, origin: string): SecretMeta {
    return this.change(handle, (record) => ({ ...record, policy: { ...record.policy, grants: record.policy.grants.filter((g) => g.origin !== origin) } }));
  }

  private change(handle: string, edit: (record: SecretRecord) => SecretRecord): SecretMeta {
    const { doc, dek } = this.ready();
    const held = this.held.get(handle);
    if (!held) throw new VaultError("not-found", `there is no secret ${handle}`);
    const next = this.withRecord(handle, (record) => {
      const edited = edit(record);
      return { ...edited, handle: record.handle, kind: record.kind, createdAt: record.createdAt, updatedAt: this.now(), version: record.version + 1 };
    })!;
    const entries = doc.entries.map((e) => (e.id === held.entry ? this.sealEntry(doc.vault, doc.dek, dek, e.id, next) : e));
    this.write({ ...doc, entries }, dek, this.opener!);
    return this.held.get(handle)!.meta;
  }

  /** The entry gone, then a new data key for the rest, in one write: a copy of the old file no longer opens with what is in memory. */
  remove(handle: string): void {
    this.ready();
    const held = this.held.get(handle);
    if (!held) throw new VaultError("not-found", `there is no secret ${handle}`);
    this.rotateDataKey(held.entry);
  }

  /** Every entry sealed again under a new data key, and every slot wrapped again, in one atomic write. */
  rotateDataKey(dropping?: string): void {
    const { doc, dek } = this.ready();
    const fresh = randomBytes(32);
    const dekId = `k${Number(doc.dek.slice(1)) + 1}`;
    const entries = doc.entries
      .filter((e) => e.id !== dropping)
      .map((e) => {
        const plain = this.openEntry(doc, dek, e);
        try {
          const nonce = randomBytes(12);
          return { id: e.id, nonce: b64(nonce), ct: b64(seal(fresh, nonce, plain, entryAad(doc.vault, e.id, dekId))) };
        } finally {
          plain.fill(0);
        }
      });
    const slots = doc.slots.map((s) => this.rewrap(doc, s, dek, fresh, dekId));
    this.write({ ...doc, dek: dekId, slots, entries }, fresh, this.opener!);
  }

  /** A slot wrapped again under the same key-encryption key: the one that opened it, or the key file's. */
  private rewrap(doc: VaultFile, slot: Slot, oldDek: Buffer, dek: Buffer, dekId: string): Slot {
    const kek = this.kekFor(doc, slot, oldDek);
    try {
      return { ...slot, wrap: wrapDek(kek, dek, doc.vault, slot.id, dekId) };
    } finally {
      if (kek !== this.opener?.kek) kek.fill(0);
    }
  }

  private kekFor(doc: VaultFile, slot: Slot, dek: Buffer): Buffer {
    if (this.opener?.kind === slot.kind) return this.opener.kek;
    if (slot.kind === "keyfile") {
      const key = this.keyBytes();
      const opened = key && unwrapDek(key, slot, doc.vault, doc.dek);
      if (key && opened && opened.equals(dek)) {
        opened.fill(0);
        return key;
      }
      key?.fill(0);
      throw new VaultError("locked", "the key file does not open this vault's key-file slot");
    }
    throw new VaultError("locked", "a passphrase slot can only be wrapped again once the passphrase opened the vault");
  }

  /** A passphrase added, or the one there changed. The vault must be open. */
  async setPassphrase(passphrase: string): Promise<void> {
    const { doc, dek } = this.ready();
    const id = doc.slots.find((s) => s.kind === "passphrase")?.id ?? `s${doc.slots.length + 1}`;
    const made = await this.passphraseSlot(passphrase, dek, doc.vault, id, doc.dek);
    const slots = [...doc.slots.filter((s) => s.kind !== "passphrase"), made.slot];
    // Held from now on: the key file can be read again whenever its slot is wrapped again, a passphrase cannot.
    this.write({ ...doc, slots }, dek, { kind: "passphrase", kek: made.kek });
  }

  /** A new key file, and the key-file slot wrapped under it. Refused while KOS_VAULT_KEY supplies the key. */
  rotateKeyfile(): void {
    const { doc, dek } = this.ready();
    if (this.options.envKey) throw new VaultError("invalid", "KOS_VAULT_KEY supplies the key: change it there and run rotate with the new one");
    const slot = doc.slots.find((s) => s.kind === "keyfile");
    if (!slot) throw new VaultError("invalid", "this vault has no key-file slot");
    const key = randomBytes(32);
    const next = `${this.keyPath}.next`;
    // The new key is on disk before the vault needs it, and replaces the old one after.
    writeAtomic(next, `${b64(key)}\n`);
    const slots = doc.slots.map((s) => (s.kind === "keyfile" ? { ...s, wrap: wrapDek(key, dek, doc.vault, s.id, doc.dek) } : s));
    const opener = this.opener?.kind === "keyfile" ? { kind: "keyfile" as const, kek: key } : this.opener!;
    this.write({ ...doc, slots }, dek, opener);
    renameSync(next, this.keyPath);
    excludeFromBackup(this.keyPath);
    if (opener.kek !== key) key.fill(0);
  }

  /** Crypto-erase: the vault, its last copy, the key and the sequence overwritten and unlinked, and the keys in memory zeroed. */
  wipe(): void {
    for (const path of [this.file, this.prev, `${this.file}.tmp`, this.keyPath, `${this.keyPath}.next`, `${this.keyPath}.tmp`, this.seqPath, `${this.seqPath}.tmp`]) shred(path);
    fsyncDir(this.dir);
    this.forget();
    this.problem = undefined;
    this.stamp = "";
    this.emit();
  }

  /**
   * A copy that only the passphrase opens: the passphrase slot alone, so the
   * key file on this machine does not travel with it. A vault without a
   * passphrase gets one for the copy only.
   */
  async exportTo(path: string, passphrase: string): Promise<void> {
    const { doc, dek } = this.ready();
    let slot = doc.slots.find((s): s is PassphraseSlot => s.kind === "passphrase");
    if (slot) {
      (await this.passphraseOpener(doc, passphrase)).kek.fill(0);
    } else {
      const made = await this.passphraseSlot(passphrase, dek, doc.vault, "s2", doc.dek);
      made.kek.fill(0);
      slot = made.slot;
    }
    writeAtomic(path, `${JSON.stringify({ ...doc, slots: [slot] }, null, 2)}\n`);
  }

  // Inside

  private present(): VaultFile {
    if (!this.doc && this.stamp) throw new VaultError("tampered", this.problem ?? "the vault file does not read");
    if (!this.doc) throw new VaultError("absent", this.problem ?? "there is no vault yet: kos secrets init, or Settings, Secrets");
    return this.doc;
  }

  private ready(): { doc: VaultFile; dek: Buffer } {
    this.refresh();
    const doc = this.present();
    if (!this.dek || !this.opener) throw new VaultError("locked", this.problem ?? "the vault is locked: unlock it with its passphrase");
    return { doc, dek: this.dek };
  }

  /** In the container the agent's programs share KOS's uid, so they could read an open vault's memory: refused unless the owner says otherwise. */
  private refuseShared(): void {
    if (this.options.contained && !this.options.allowSharedUid) {
      throw new VaultError("refused", "in the container tools still run as KOS's own user, so the vault stays shut; set KOS_VAULT_ALLOW_SHARED_UID=1 to open it anyway");
    }
  }

  private keyBytes(): Buffer | undefined {
    const text = this.options.envKey ?? (existsSync(this.keyPath) ? readFileSync(this.keyPath, "utf8").trim() : undefined);
    if (!text) return undefined;
    const key = unb64(text);
    if (key.length !== 32) throw new VaultError("invalid", this.options.envKey ? "KOS_VAULT_KEY is not 32 bytes of base64" : `${this.keyPath} is not 32 bytes of base64`);
    return key;
  }

  private makeKey(): Buffer {
    const key = randomBytes(32);
    writeAtomic(this.keyPath, `${b64(key)}\n`);
    excludeFromBackup(this.keyPath);
    return key;
  }

  private sealEntry(vault: string, dekId: string, dek: Buffer, id: string, record: SecretRecord): Entry {
    const nonce = randomBytes(12);
    const plain = Buffer.from(JSON.stringify(record), "utf8");
    try {
      return { id, nonce: b64(nonce), ct: b64(seal(dek, nonce, plain, entryAad(vault, id, dekId))) };
    } finally {
      plain.fill(0);
    }
  }

  private openEntry(doc: VaultFile, dek: Buffer, entry: Entry): Buffer {
    try {
      return unseal(dek, unb64(entry.nonce), unb64(entry.ct), entryAad(doc.vault, entry.id, doc.dek));
    } catch {
      throw new VaultError("tampered", `entry ${entry.id} does not open: the vault file was changed outside KOS`);
    }
  }

  private highWater(): { vault: string; seq: number } | undefined {
    if (!existsSync(this.seqPath)) return undefined;
    const [vault, seq] = readFileSync(this.seqPath, "utf8").trim().split(" ");
    return vault && seq && /^\d+$/.test(seq) ? { vault, seq: Number(seq) } : undefined;
  }

  /** Every check a file read from disk must pass before anything in it is believed. */
  private verify(doc: VaultFile, dek: Buffer): Map<string, Held> {
    const mac = indexMac(dek, doc.vault, doc.index.seq, doc.entries.map((e) => e.id));
    const given = unb64(doc.index.mac);
    if (given.length !== 32 || !timingSafeEqual(given, unb64(mac))) throw new VaultError("tampered", "the vault's index does not match its entries: one was dropped, added or changed outside KOS");
    const seen = this.highWater();
    if (seen && seen.vault === doc.vault && doc.index.seq < seen.seq) {
      throw new VaultError("tampered", `the vault file is older than one KOS wrote (sequence ${doc.index.seq}, last ${seen.seq}): an old copy was put back`);
    }
    const held = new Map<string, Held>();
    for (const entry of doc.entries) {
      const plain = this.openEntry(doc, dek, entry);
      try {
        const record = JSON.parse(plain.toString("utf8")) as SecretRecord;
        if (held.has(record.handle)) throw new VaultError("tampered", `two entries hold ${record.handle}`);
        const { values, ...rest } = record;
        const fields = (Object.keys(values) as SecretFieldName[]).filter((f) => values[f] !== undefined && values[f] !== "");
        held.set(record.handle, { entry: entry.id, meta: { ...rest, fields } });
      } finally {
        plain.fill(0);
      }
    }
    return held;
  }

  /** The data key from what opened it before, or from the key file when there is no passphrase to wait for. */
  private openWith(doc: VaultFile): { dek: Buffer; opener: Opener } | undefined {
    if (this.opener) {
      const slot = doc.slots.find((s) => s.kind === this.opener!.kind);
      const dek = slot && unwrapDek(this.opener.kek, slot, doc.vault, doc.dek);
      if (dek) return { dek, opener: this.opener };
    }
    // A passphrase locks the vault after every start until it is given.
    if (doc.slots.some((s) => s.kind === "passphrase")) return undefined;
    const slot = doc.slots.find((s) => s.kind === "keyfile");
    if (!slot) return undefined;
    for (const key of [this.keyBytes(), this.nextKey()]) {
      const dek = key && unwrapDek(key, slot, doc.vault, doc.dek);
      if (key && dek) return { dek, opener: { kind: "keyfile", kek: key } };
      key?.fill(0);
    }
    throw new VaultError("locked", "the key file does not open this vault");
  }

  /** A new key a rotation wrote but had not yet put in place when it stopped. */
  private nextKey(): Buffer | undefined {
    const next = `${this.keyPath}.next`;
    if (this.options.envKey || !existsSync(next)) return undefined;
    const key = unb64(readFileSync(next, "utf8").trim());
    return key.length === 32 ? key : undefined;
  }

  /** Read the file again when it changed since it was last read. */
  private refresh(): void {
    let stamp = "";
    try {
      const st = statSync(this.file);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      stamp = "";
    }
    if (stamp === this.stamp && (stamp === "" || this.doc || this.problem)) return;
    this.stamp = stamp;
    const before = this.held;
    if (!stamp) {
      this.problem = undefined;
      this.doc = undefined;
      this.forget();
      if (before.size) this.emit();
      return;
    }
    this.problem = undefined;
    try {
      const doc = parseVault(readFileSync(this.file, "utf8"));
      this.doc = doc;
      this.refuseShared();
      const opened = this.openWith(doc);
      if (!opened) {
        this.lockOnly();
      } else {
        this.held = this.verify(doc, opened.dek);
        if (this.dek && this.dek !== opened.dek) this.dek.fill(0);
        this.dek = opened.dek;
        if (this.opener && this.opener !== opened.opener) this.opener.kek.fill(0);
        this.opener = opened.opener;
      }
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
      this.lockOnly();
    }
    if (before !== this.held) this.emit();
  }

  /** Locked, the file still known. */
  private lockOnly(): void {
    this.dek?.fill(0);
    this.dek = undefined;
    this.held = new Map();
  }

  private forget(): void {
    this.dek?.fill(0);
    this.opener?.kek.fill(0);
    this.dek = undefined;
    this.opener = undefined;
    this.doc = undefined;
    this.held = new Map();
  }

  private write(doc: VaultFile, dek: Buffer, opener: Opener): void {
    const seq = Math.max(doc.index.seq, this.highWater()?.vault === doc.vault ? this.highWater()!.seq : 0) + 1;
    const next: VaultFile = { ...doc, index: { seq, mac: indexMac(dek, doc.vault, seq, doc.entries.map((e) => e.id)) } };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) {
      copyFileSync(this.file, `${this.prev}.tmp`);
      chmodSync(`${this.prev}.tmp`, 0o600);
      renameSync(`${this.prev}.tmp`, this.prev);
    }
    writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    writeAtomic(this.seqPath, `${next.vault} ${seq}\n`);
    fsyncDir(this.dir);
    if (this.dek && this.dek !== dek) this.dek.fill(0);
    if (this.opener && this.opener.kek !== opener.kek) this.opener.kek.fill(0);
    this.dek = dek;
    this.opener = opener;
    this.stamp = "";
    this.doc = undefined;
    this.refresh();
    if (!this.dek) throw new VaultError("tampered", this.problem ?? "the vault did not read back");
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
