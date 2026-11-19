import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { SecretFieldName, SecretKind, SecretPolicy, SecretSummary, SecretUse, SecretValues, VaultSlotKind } from "@kos/shared";

import { buildIndex, SCRUB_INDEX_FORMAT, SCRUB_INDEX_VERSION, ScrubIndex, type ScrubIndexFile } from "./scrubindex.js";
import { checkDir, copyAtomic, excludeFromBackup, fsyncDir, readPrivate, shred, VaultFsError, withFileLock, writeAtomic } from "./vaultfs.js";
import { checkPolicy, checkUse, checkValues, grantAllowed, hintOf, labelOf, scannedOf, slugOf, type ScannedValue } from "./records.js";

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
const LOCK_FILE = "vault.lock";
/** What the scrubber reads while the vault is locked (scrubindex.ts), and the key it is made under. */
const INDEX_FILE = "scrub.kosi";
const INDEX_KEY_FILE = "scrub.key";
/** How often a hot caller looks for a change another process made. */
const POLL_MS = 1_000;

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

const sha256 = (...parts: Buffer[]): string => {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  return h.digest("hex");
};

/** What the index MAC says of a slot: everything in it, so no part of one can be swapped for an older copy's. */
function slotDigest(slot: Slot): string {
  const kdf = slot.kind === "passphrase" ? `${slot.kdf.alg}|${slot.kdf.N}|${slot.kdf.r}|${slot.kdf.p}|${slot.kdf.salt}` : "";
  return `${slot.id}:${sha256(Buffer.from(`${slot.kind}|${kdf}|${slot.wrap.alg}|${slot.wrap.nonce}|${slot.wrap.ct}`, "utf8"))}`;
}

/**
 * The index MAC: over the vault id, the data key's id, the sequence number,
 * every slot whole, and every entry as its id with SHA-256 of its nonce and
 * ciphertext. An entry pasted in from an older copy (its id the same, its
 * bytes from before) changes its digest, so it is refused like any edit.
 */
export function indexMac(dek: Buffer, doc: Pick<VaultFile, "vault" | "dek" | "slots" | "entries">, seq: number): string {
  const slots = [...doc.slots].sort((a, b) => (a.id < b.id ? -1 : 1)).map(slotDigest).join(",");
  const entries = [...doc.entries]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((e) => `${e.id}:${sha256(unb64(e.nonce), unb64(e.ct))}`)
    .join(",");
  const key = indexKey(dek);
  try {
    return createHmac("sha256", key).update(`${TAG}|${doc.vault}|${doc.dek}|${seq}|slots:${slots}|entries:${entries}`).digest("base64");
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

/** A passphrase's key-encryption key and the salt it was made with. */
interface PassphraseKey {
  kek: Buffer;
  salt: Buffer;
}

function passphraseSlotOf(pass: PassphraseKey, dek: Buffer, vault: string, id: string, dekId: string): PassphraseSlot {
  return { id, kind: "passphrase", kdf: { alg: "scrypt", ...SCRYPT, salt: b64(pass.salt) }, wrap: wrapDek(pass.kek, dek, vault, id, dekId) };
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

export interface VaultOptions {
  dir: string;
  /** KOS_VAULT_KEY: the key file's 32 bytes as base64, for the container, where there is no key file. */
  envKey?: string;
  /** Running in the container, where tools still share KOS's uid. */
  contained?: boolean;
  /** KOS_VAULT_ALLOW_SHARED_UID=1: open the vault in the container anyway. */
  allowSharedUid?: boolean;
  /** The workspace, which the vault's folder must never be inside: it is snapshotted to git and open to the agent. */
  workspace?: string;
  /** The second record of the highest sequence written, outside the vault's folder: `<dir>.seq` unless given. */
  seqCopy?: string;
  now?: () => number;
}

/** A path with every link resolved, as far as it exists; the rest as given. */
export function realOf(path: string): string {
  const abs = resolve(path);
  let at = abs;
  const rest: string[] = [];
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return abs;
    rest.unshift(basename(at));
    at = up;
  }
  return join(realpathSync(at), ...rest);
}

const isWithin = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

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
  private readonly seqCopy: string;
  private readonly lockPath: string;
  private readonly indexPath: string;
  private readonly indexKeyPath: string;
  /** The scrub index as last read, and the stamp of the file it was read from. */
  private index: { stamp: string; index: ScrubIndex | undefined } | undefined;
  private readonly now: () => number;
  /** How deep this process is inside the vault's file lock, so a change made inside another takes it once. */
  private lockDepth = 0;

  private doc: VaultFile | undefined;
  /** mtime, size and inode of the file last read, so a change made by another process is noticed. */
  private stamp = "";
  private dek: Buffer | undefined;
  private opener: Opener | undefined;
  private problem: string | undefined;
  /** Something the owner should see about a vault that still opened. */
  private warning: string | undefined;
  private held = new Map<string, Held>();
  private polled = 0;
  private indexStale = true;
  /** Why the scrub index cannot be written or read, for the status. */
  private indexProblem: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: VaultOptions) {
    this.dir = options.dir;
    this.file = join(this.dir, VAULT_FILE);
    this.prev = `${this.file}.prev`;
    this.keyPath = join(this.dir, KEY_FILE);
    this.seqPath = join(this.dir, SEQ_FILE);
    this.seqCopy = options.seqCopy ?? `${this.dir.replace(/\/+$/, "")}.seq`;
    this.lockPath = join(this.dir, LOCK_FILE);
    this.indexPath = join(this.dir, INDEX_FILE);
    this.indexKeyPath = join(this.dir, INDEX_KEY_FILE);
    this.now = options.now ?? Date.now;
    this.refresh();
  }

  static fromEnv(env: NodeJS.ProcessEnv, contained: boolean, workspace?: string): Vault {
    return new Vault({
      dir: vaultDir(env),
      ...(workspace ? { workspace } : {}),
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

  /**
   * The owner's word that the vault file on disk is the one they expect,
   * for a vault both sequence records of which went missing: both written
   * again at its sequence. Only a sequence the vault's own MAC vouches for
   * is recorded, so the data key is opened (the key file, or the passphrase)
   * and the index checked first; nothing else is decrypted.
   */
  async trustSeq(passphrase?: string): Promise<void> {
    this.refresh();
    const doc = this.present();
    const pass = doc.slots.some((sl) => sl.kind === "passphrase");
    const kek = pass ? (await this.passphraseOpener(doc, passphrase ?? "")).kek : this.keyBytes();
    const slot = doc.slots.find((sl) => sl.kind === (pass ? "passphrase" : "keyfile"));
    const dek = kek && slot ? unwrapDek(kek, slot, doc.vault, doc.dek) : undefined;
    kek?.fill(0);
    if (!dek) throw new VaultError("locked", "the vault does not open with what was given, so its sequence cannot be vouched for");
    const given = unb64(doc.index.mac);
    const sound = given.length === 32 && timingSafeEqual(given, unb64(indexMac(dek, doc, doc.index.seq)));
    dek.fill(0);
    if (!sound) throw new VaultError("tampered", "the vault's index does not match its entries, so there is no sequence to trust");
    this.locked(() => {
      // The file under the lock must still be the one just checked.
      const now = this.doc;
      if (!now || now.vault !== doc.vault || now.index.seq !== doc.index.seq || now.index.mac !== doc.index.mac) throw new VaultError("tampered", "the vault changed while it was being checked; run trust-seq again");
      writeAtomic(this.seqPath, `${doc.vault} ${doc.index.seq}\n`, this.dir);
      writeAtomic(this.seqCopy, `${doc.vault} ${doc.index.seq}\n`, dirname(this.seqCopy));
      this.stamp = "";
      this.refresh();
    });
  }

  /** Read the file again if another process changed it, at most once a second: for a caller as hot as the scrubber. */
  poll(): void {
    const t = this.now();
    if (t - this.polled < POLL_MS) return;
    this.polled = t;
    this.indexStale = true;
    this.refresh();
  }

  status(): { state: "absent" | "locked" | "ready"; slots: VaultSlotKind[]; problem?: string } {
    this.refresh();
    // A file that is there but will not read is a vault shut, not one missing: init must not write over it.
    if (!this.doc) return { state: this.stamp ? "locked" : "absent", slots: [], ...(this.problem ? { problem: this.problem } : {}) };
    const slots = [...new Set(this.doc.slots.map((s) => s.kind))];
    const problem = this.problem ?? (this.dek ? this.warning : undefined) ?? (this.dek ? this.indexProblem : this.shut() && this.indexProblem);
    return { state: this.dek ? "ready" : "locked", slots, ...(problem ? { problem } : {}) };
  }

  /**
   * While the vault is there but shut (a passphrase not yet given, a file
   * refused), what the scrubber can still use: the scrub index, when there
   * is one. Undefined while the vault is open or there is none at all.
   */
  shut(): { index: ScrubIndex | undefined } | undefined {
    // As fresh as the last poll: this is asked on every write the scrubber sees.
    if (!this.stamp || this.dek) return undefined;
    if (this.index && !this.indexStale) return { index: this.index.index };
    this.indexStale = false;
    let stamp = "";
    try {
      const st = statSync(this.indexPath);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      stamp = "";
    }
    if (this.index?.stamp !== stamp) {
      let index: ScrubIndex | undefined;
      this.indexProblem = stamp ? undefined : "there is no scrub index, so only shapes are masked until the vault is unlocked";
      try {
        const file = stamp ? (JSON.parse(readPrivate(this.indexPath)) as ScrubIndexFile) : undefined;
        const current = file?.format === SCRUB_INDEX_FORMAT && file.version === SCRUB_INDEX_VERSION;
        const key = current ? unb64(readPrivate(this.indexKeyPath).trim()) : undefined;
        index = file && key?.length === 32 ? new ScrubIndex(key, file) : undefined;
        if (file && !index) this.indexProblem = "the scrub index is from an older KOS or its key is wrong; unlock the vault to make it again";
      } catch (err) {
        index = undefined;
        this.indexProblem = `the scrub index does not read (${err instanceof Error ? err.message : String(err)}), so only shapes are masked until the vault is unlocked`;
      }
      this.index = { stamp, index };
    }
    return { index: this.index.index };
  }

  /** The scrub index made again from every value, under the scrub key (made once). Only while the vault is open. */
  /**
   * The scrub index made again from every value. A change is already
   * committed when this runs, so a failure here never fails it: it is
   * logged and shown in the status until an index is written.
   */
  private writeIndex(): void {
    if (!this.dek) return;
    try {
      let key = existsSync(this.indexKeyPath) ? unb64(readPrivate(this.indexKeyPath).trim()) : undefined;
      if (key?.length !== 32) {
        key = randomBytes(32);
        writeAtomic(this.indexKeyPath, `${b64(key)}\n`, this.dir);
        excludeFromBackup(this.indexKeyPath);
      }
      writeAtomic(this.indexPath, `${JSON.stringify(buildIndex(key, this.scanned()))}\n`, this.dir);
      key.fill(0);
      this.indexProblem = undefined;
    } catch (err) {
      this.indexProblem = `the scrub index was not written (${err instanceof Error ? err.message : String(err)}), so a locked vault masks only by shape`;
      console.error(`[secrets] ${this.indexProblem}`);
    }
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
    // Opened: a key file left beside a vault that no longer uses one goes now.
    this.locked(() => undefined);
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

  /**
   * Create the vault. With a passphrase, the passphrase slot is its only
   * slot and no key file is written: nothing on disk opens it, so it is
   * locked after every start until the passphrase is given. Without one, a
   * key-file slot, and the vault opens by itself.
   */
  async init(options: { passphrase?: string } = {}): Promise<void> {
    this.refuseShared();
    const pass = options.passphrase !== undefined ? await this.passphraseKey(options.passphrase) : undefined;
    this.locked(() => {
      this.refresh();
      if (this.doc || existsSync(this.file)) throw new VaultError("exists", "there is a vault already");
      chmodSync(this.dir, 0o700);
      const dek = randomBytes(32);
      const vault = `v_${hex(8)}`;
      const dekId = "k1";
      let slot: Slot;
      let opener: Opener;
      if (pass) {
        slot = passphraseSlotOf(pass, dek, vault, "s1", dekId);
        opener = { kind: "passphrase", kek: pass.kek };
        this.dropKeyFile();
      } else {
        const key = this.keyBytes() ?? this.makeKey();
        slot = { id: "s1", kind: "keyfile", wrap: wrapDek(key, dek, vault, "s1", dekId) };
        opener = { kind: "keyfile", kek: key };
      }
      this.write({ format: VAULT_FORMAT, version: VAULT_VERSION, vault, dek: dekId, slots: [slot], entries: [], index: { seq: 0, mac: "" } }, dek, opener, true);
    });
  }

  /** scrypt of a new passphrase with a fresh salt: slow, so done before the vault is locked for the write. */
  private async passphraseKey(passphrase: string): Promise<PassphraseKey> {
    if (passphrase.length < 8) throw new VaultError("invalid", "a passphrase is at least 8 characters");
    const salt = randomBytes(16);
    return { kek: await passphraseKek(passphrase, salt), salt };
  }

  // Changing

  add(input: NewSecret): string {
    return this.locked(() => {
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
    });
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
        policy: { ...policy, grants: policy.grants.filter((g) => grantAllowed(g.origin, use)) },
        hint: hintOf(record.kind, values),
      };
    });
  }

  /**
   * A yes kept for one origin: the secret's uses there stop asking. Only an
   * approval adds one, and only on an origin the secret is allowed on.
   */
  addGrant(handle: string, origin: string): SecretMeta {
    return this.change(handle, (record) => {
      if (!grantAllowed(origin, record.use)) throw new VaultError("invalid", `${handle} is not allowed on ${origin}`);
      const grants = [...record.policy.grants.filter((g) => g.origin !== origin), { origin, at: this.now() }];
      return { ...record, policy: { ...record.policy, grants } };
    });
  }

  /** A site added to where a secret may be filled, as the owner approved it. */
  allowOrigin(handle: string, origin: string): SecretMeta {
    return this.change(handle, (record) => {
      const web = record.use.web;
      const use = checkUse({ ...record.use, web: { ...web, origins: [...web.origins.filter((o) => o !== origin), origin] } });
      return { ...record, use };
    });
  }

  /** A remembered grant taken back. */
  revokeGrant(handle: string, origin: string): SecretMeta {
    return this.change(handle, (record) => ({ ...record, policy: { ...record.policy, grants: record.policy.grants.filter((g) => g.origin !== origin) } }));
  }

  private change(handle: string, edit: (record: SecretRecord) => SecretRecord): SecretMeta {
    return this.locked(() => {
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
    });
  }

  /** The entry gone, then a new data key for the rest, in one write: a copy of the old file no longer opens with what is in memory. */
  remove(handle: string): void {
    this.locked(() => {
      this.ready();
      const held = this.held.get(handle);
      if (!held) throw new VaultError("not-found", `there is no secret ${handle}`);
      this.reseal({ dropping: held.entry });
    });
  }

  /** Every entry sealed again under a new data key, and every slot wrapped again, in one atomic write. */
  rotateDataKey(): void {
    this.locked(() => this.reseal({}));
  }

  /**
   * A new data key: every entry sealed again under it, an entry dropped if
   * asked, and the slots wrapped again (the same ones, or those `slots`
   * makes), in one write that erases `.prev`.
   */
  private reseal(change: { dropping?: string; slots?: (dek: Buffer, vault: string, dekId: string) => { slots: Slot[]; opener: Opener } }): void {
    const { doc, dek } = this.ready();
    const fresh = randomBytes(32);
    const dekId = `k${Number(doc.dek.slice(1)) + 1}`;
    const entries = doc.entries
      .filter((e) => e.id !== change.dropping)
      .map((e) => {
        const plain = this.openEntry(doc, dek, e);
        try {
          const nonce = randomBytes(12);
          return { id: e.id, nonce: b64(nonce), ct: b64(seal(fresh, nonce, plain, entryAad(doc.vault, e.id, dekId))) };
        } finally {
          plain.fill(0);
        }
      });
    const made = change.slots?.(fresh, doc.vault, dekId) ?? { slots: doc.slots.map((sl) => this.rewrap(doc, sl, dek, fresh, dekId)), opener: this.opener! };
    this.write({ ...doc, dek: dekId, slots: made.slots, entries }, fresh, made.opener, true);
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

  /**
   * A passphrase added, or the one there changed: a new data key, wrapped
   * under the passphrase alone, `.prev` erased and the key file erased, so
   * nothing on disk opens the vault and from the next start it waits for
   * the passphrase. The vault must be open.
   */
  async setPassphrase(passphrase: string): Promise<void> {
    this.ready();
    const pass = await this.passphraseKey(passphrase);
    this.locked(() => {
      this.reseal({ slots: (dek, vault, dekId) => ({ slots: [passphraseSlotOf(pass, dek, vault, "s1", dekId)], opener: { kind: "passphrase", kek: pass.kek } }) });
      this.dropKeyFile();
    });
  }

  /** The passphrase taken off: a new data key under a key file alone, and the vault opens by itself again. The vault must be open. */
  removePassphrase(): void {
    this.locked(() => {
      const { doc } = this.ready();
      if (!doc.slots.some((sl) => sl.kind === "passphrase")) throw new VaultError("invalid", "this vault has no passphrase");
      const key = this.keyBytes() ?? this.makeKey();
      this.reseal({ slots: (dek, vault, dekId) => ({ slots: [{ id: "s1", kind: "keyfile", wrap: wrapDek(key, dek, vault, "s1", dekId) }], opener: { kind: "keyfile", kek: key } }) });
    });
  }

  /**
   * A key file no slot of an opened vault uses (a passphrase added while
   * KOS was away): erased, nothing should be left to try. Only under the
   * lock, after the vault was read again: outside it, the key a CLI just
   * wrote for its next write would look orphaned.
   */
  private dropOrphanKey(): void {
    if (this.dek && this.doc && !this.options.envKey && !this.doc.slots.some((sl) => sl.kind === "keyfile")) this.dropKeyFile();
  }

  /** A key file no slot needs any more, overwritten and unlinked: a copy of it opens nothing, but nothing should be left to try. */
  private dropKeyFile(): void {
    for (const path of [this.keyPath, `${this.keyPath}.next`, `${this.keyPath}.tmp`]) shred(path);
  }

  /** A new key file, and the key-file slot wrapped under it; `.prev`, wrapped under the old key, is erased. Refused while KOS_VAULT_KEY supplies the key. */
  rotateKeyfile(): void {
    this.locked(() => {
      const { doc, dek } = this.ready();
      if (this.options.envKey) throw new VaultError("invalid", "KOS_VAULT_KEY supplies the key: change it there and run rotate with the new one");
      if (!doc.slots.some((sl) => sl.kind === "keyfile")) throw new VaultError("invalid", "this vault has no key-file slot");
      const key = randomBytes(32);
      const next = `${this.keyPath}.next`;
      // The new key is on disk before the vault needs it, and replaces the old one after.
      writeAtomic(next, `${b64(key)}\n`, this.dir);
      const slots = doc.slots.map((sl) => (sl.kind === "keyfile" ? { ...sl, wrap: wrapDek(key, dek, doc.vault, sl.id, doc.dek) } : sl));
      const opener = this.opener?.kind === "keyfile" ? { kind: "keyfile" as const, kek: key } : this.opener!;
      this.write({ ...doc, slots }, dek, opener, true);
      renameSync(next, this.keyPath);
      fsyncDir(this.dir);
      excludeFromBackup(this.keyPath);
      if (opener.kek !== key) key.fill(0);
    });
  }

  /**
   * Crypto-erase: the vault, its last copy, the key and both sequence
   * records overwritten and unlinked, and the keys in memory zeroed. A
   * passphrase vault is wiped only with its passphrase: its owner proved it
   * is them, not only whoever holds the dashboard.
   */
  async wipe(passphrase?: string): Promise<void> {
    if (this.hasPassphrase() && !(await this.checkPassphrase(passphrase ?? ""))) throw new VaultError("passphrase", "wiping this vault takes its passphrase");
    this.locked(() => {
      for (const path of [this.file, this.prev, `${this.prev}.tmp`, `${this.file}.tmp`, this.keyPath, `${this.keyPath}.next`, `${this.keyPath}.tmp`, this.seqPath, `${this.seqPath}.tmp`, this.seqCopy, `${this.seqCopy}.tmp`, this.indexPath, `${this.indexPath}.tmp`, this.indexKeyPath, `${this.indexKeyPath}.tmp`]) shred(path);
      this.index = undefined;
      fsyncDir(this.dir);
      this.forget();
      this.problem = undefined;
      this.warning = undefined;
      this.stamp = "";
    });
    this.emit();
  }

  /**
   * A copy that only the passphrase opens: the passphrase slot alone, so the
   * key file on this machine does not travel with it. A vault without a
   * passphrase gets one for the copy only.
   */
  async exportTo(path: string, passphrase: string): Promise<void> {
    const { doc } = this.ready();
    const mine = doc.slots.find((sl): sl is PassphraseSlot => sl.kind === "passphrase");
    if (mine) (await this.passphraseOpener(doc, passphrase)).kek.fill(0);
    const pass = mine ? undefined : await this.passphraseKey(passphrase);
    const { doc: now, dek } = this.ready();
    const slot = mine ? now.slots.find((sl) => sl.kind === "passphrase")! : passphraseSlotOf(pass!, dek, now.vault, "s1", now.dek);
    pass?.kek.fill(0);
    const copy = { ...now, slots: [slot] };
    writeAtomic(path, `${JSON.stringify({ ...copy, index: { seq: now.index.seq, mac: indexMac(dek, copy, now.index.seq) } }, null, 2)}\n`, dirname(path));
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
    if (this.options.workspace && isWithin(realOf(this.dir), realOf(this.options.workspace))) {
      throw new VaultError("refused", `the vault's folder ${this.dir} is inside the workspace, which is backed up to git and open to the agent; set KOS_VAULT_DIR outside it`);
    }
    if (this.options.contained && !this.options.allowSharedUid) {
      throw new VaultError("refused", "in the container tools still run as KOS's own user, so the vault stays shut; set KOS_VAULT_ALLOW_SHARED_UID=1 to open it anyway");
    }
  }

  private keyBytes(): Buffer | undefined {
    const text = this.options.envKey ?? (existsSync(this.keyPath) ? readPrivate(this.keyPath).trim() : undefined);
    if (!text) return undefined;
    const key = unb64(text);
    if (key.length !== 32) throw new VaultError("invalid", this.options.envKey ? "KOS_VAULT_KEY is not 32 bytes of base64" : `${this.keyPath} is not 32 bytes of base64`);
    return key;
  }

  private makeKey(): Buffer {
    const key = randomBytes(32);
    writeAtomic(this.keyPath, `${b64(key)}\n`, this.dir);
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

  /**
   * The highest sequence written for this vault, by either record: the one
   * in the folder and its copy outside it. Both must be put back to pass an
   * old copy off; `missing` says one of them is gone.
   */
  private highWater(vault: string): { seq: number; missing: number } {
    let seq = 0;
    let missing = 0;
    for (const path of [this.seqPath, this.seqCopy]) {
      if (!existsSync(path)) {
        missing++;
        continue;
      }
      const [id, n] = readPrivate(path).trim().split(" ");
      if (id === vault && n && /^\d+$/.test(n)) seq = Math.max(seq, Number(n));
      else missing++;
    }
    return { seq, missing };
  }

  /** Every check a file read from disk must pass before anything in it is believed. */
  private verify(doc: VaultFile, dek: Buffer): Map<string, Held> {
    const mac = indexMac(dek, doc, doc.index.seq);
    const given = unb64(doc.index.mac);
    if (given.length !== 32 || !timingSafeEqual(given, unb64(mac))) throw new VaultError("tampered", "the vault's index does not match its entries: one was dropped, added or changed outside KOS");
    const seen = this.highWater(doc.vault);
    if (doc.index.seq < seen.seq) {
      throw new VaultError("tampered", `the vault file is older than one KOS wrote (sequence ${doc.index.seq}, last ${seen.seq}): an old copy was put back`);
    }
    // Both gone: nothing says this is not an old copy, so it waits for the owner to say it is the one.
    if (seen.missing === 2 && doc.index.seq > 0) {
      throw new VaultError("tampered", `both records of the vault's last sequence are missing (${this.seqPath} and ${this.seqCopy}), so an older copy put back could not be told from this one; if this is the vault you expect, run kos secrets trust-seq`);
    }
    this.warning =
      seen.missing > 0 && doc.index.seq > 0
        ? `a record of the vault's last sequence is missing (${this.seqPath} or ${this.seqCopy}), so an older copy put back could not be told from this one; the next change writes it again`
        : undefined;
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
    const key = unb64(readPrivate(next).trim());
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
    this.warning = undefined;
    try {
      checkDir(this.dir);
      const doc = parseVault(readPrivate(this.file));
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
        // A vault from before the scrub index gets one the first time it opens.
        if (!existsSync(this.indexPath)) this.writeIndex();
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

  /**
   * Seal the vault to disk. The copy before is kept as `.prev`, synced,
   * except after a change of keys (`dropPrev`): then `.prev` is erased, or
   * it would still open with a key that should no longer open anything.
   */
  private write(doc: VaultFile, dek: Buffer, opener: Opener, dropPrev = false): void {
    const seq = Math.max(doc.index.seq, this.highWater(doc.vault).seq) + 1;
    const next: VaultFile = { ...doc, index: { seq, mac: indexMac(dek, doc, seq) } };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (dropPrev) shred(this.prev);
    else if (existsSync(this.file)) copyAtomic(this.file, this.prev, this.dir);
    // The vault first, then each sequence record: a crash between leaves a record lower than the vault, never higher.
    writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, this.dir);
    writeAtomic(this.seqPath, `${next.vault} ${seq}\n`, this.dir);
    writeAtomic(this.seqCopy, `${next.vault} ${seq}\n`, dirname(this.seqCopy));
    if (this.dek && this.dek !== dek) this.dek.fill(0);
    if (this.opener && this.opener.kek !== opener.kek) this.opener.kek.fill(0);
    this.dek = dek;
    this.opener = opener;
    this.stamp = "";
    this.doc = undefined;
    this.refresh();
    if (!this.dek) throw new VaultError("tampered", this.problem ?? "the vault did not read back");
    this.writeIndex();
  }

  /** `run` under the vault's file lock, so the host and the CLI never interleave a read and a write. */
  private locked<T>(run: () => T): T {
    if (this.lockDepth > 0) return run();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.lockDepth++;
    try {
      return withFileLock(this.lockPath, () => {
        // Read again under the lock: what another process wrote before it let go is what this change starts from.
        this.stamp = "";
        this.refresh();
        this.dropOrphanKey();
        return run();
      });
    } catch (err) {
      // A file that is not private, or a lock held too long: the vault is shut for this change, and the owner is told why.
      if (err instanceof VaultFsError) throw new VaultError("refused", err.message);
      throw err;
    } finally {
      this.lockDepth--;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
