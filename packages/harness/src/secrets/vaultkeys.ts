import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/**
 * The vault's key primitives (docs/secrets.md, The vault): AES-256-GCM, and
 * the P-256 key agreement a slot is sealed to a public key with, as
 * age-plugin-se does it. An ephemeral P-256 key, ECDH with the slot's key,
 * HKDF-SHA256 over the shared x-coordinate (salt: the ephemeral key, then
 * the slot's key; info names the vault and the slot), and the data key
 * sealed under the result.
 *
 * Kept apart from vault.ts so KOS for Mac's side of `vault.unwrap` has one
 * reference to be checked against (the known-answer vectors).
 */

/** An uncompressed SEC1 P-256 point: 0x04, then x and y. */
export const P256_POINT_BYTES = 65;

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

export interface P256Pair {
  /** The scalar, 32 bytes big-endian. */
  priv: Buffer;
  /** The point, uncompressed. */
  pub: Buffer;
}

/** A fresh P-256 key pair, or the one `priv` makes; throws for a scalar out of range. */
export function p256Pair(priv?: Buffer): P256Pair {
  const ecdh = createECDH("prime256v1");
  if (priv) ecdh.setPrivateKey(priv);
  else ecdh.generateKeys();
  const scalar = ecdh.getPrivateKey();
  // Node drops leading zero bytes; the format is always 32.
  return { priv: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]), pub: ecdh.getPublicKey(undefined, "uncompressed") };
}

/** ECDH's shared x-coordinate; throws for a point not on the curve. */
export function p256Shared(priv: Buffer, pub: Buffer): Buffer {
  if (pub.length !== P256_POINT_BYTES || pub[0] !== 0x04) throw new Error("not an uncompressed P-256 point");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(priv);
  return ecdh.computeSecret(pub);
}

/** The info a device slot's key is derived under. */
export const deviceInfo = (vault: string, slot: string): string => `kos-vault/2 device|${vault}|${slot}`;
/** The info a passphrase slot's key is derived under. */
export const passphraseInfo = (vault: string, slot: string): string => `kos-vault/2 passphrase|${vault}|${slot}`;
/** The info the key KOS for Mac seals its answer under is derived with. */
export const unwrapInfo = (vault: string, slot: string): string => `kos-vault/2 unwrap|${vault}|${slot}`;
/** The AAD of KOS for Mac's answer to `vault.unwrap`. */
export const unwrapAad = (vault: string, slot: string): Buffer => Buffer.from(`kos-vault/2|unwrap|${vault}|${slot}`, "utf8");

/** HKDF-SHA256 of an ECDH secret: salt the ephemeral point then the recipient's, 32 bytes out. */
export function agreedKey(shared: Buffer, epk: Buffer, recipient: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, recipient]), info, 32));
}

/**
 * A key only the holder of `recipient`'s private half can make again: the
 * ephemeral point to store beside what it seals, and the key. `eph` is for
 * the known-answer vectors; otherwise one is made and forgotten.
 */
export function keyTo(recipient: Buffer, info: string, eph: P256Pair = p256Pair()): { epk: Buffer; kek: Buffer } {
  const shared = p256Shared(eph.priv, recipient);
  try {
    return { epk: eph.pub, kek: agreedKey(shared, eph.pub, recipient, info) };
  } finally {
    shared.fill(0);
    eph.priv.fill(0);
  }
}

/** The key `keyTo` made, made again by the holder of the recipient's private half. */
export function keyFrom(priv: Buffer, recipient: Buffer, epk: Buffer, info: string): Buffer {
  const shared = p256Shared(priv, epk);
  try {
    return agreedKey(shared, epk, recipient, info);
  } finally {
    shared.fill(0);
  }
}

/**
 * A passphrase slot's P-256 scalar: HKDF-SHA256 of scrypt's 32 bytes (empty
 * salt, info `kos-vault/2 passphrase key`). A data key is sealed to its
 * point, so a slot is wrapped again under a new data key without the
 * passphrase; only opening it needs the passphrase. Undefined in the
 * 2^-32 case of a scalar out of range: a new salt makes another.
 */
export function passphraseScalar(stretched: Buffer): P256Pair | undefined {
  const scalar = Buffer.from(hkdfSync("sha256", stretched, Buffer.alloc(0), "kos-vault/2 passphrase key", 32));
  try {
    return p256Pair(scalar);
  } catch {
    return undefined;
  } finally {
    scalar.fill(0);
  }
}

/** What KOS for Mac answers `vault.unwrap` with: the slot's key sealed to the host's ephemeral point. */
export interface UnwrapAnswer {
  epk: string;
  nonce: string;
  ct: string;
}

/**
 * The device's side of `vault.unwrap`, as KOS for Mac does it (VaultUnwrap.swift):
 * the slot's key sealed under HKDF of ECDH between a fresh point of its own
 * and the host's. The host's tests stand in for a Mac with it.
 */
export function sealToHost(slotKey: Buffer, hostEpk: Buffer, vault: string, slot: string, eph: P256Pair = p256Pair(), nonce: Buffer = randomBytes(12)): UnwrapAnswer {
  const { epk, kek } = keyTo(hostEpk, unwrapInfo(vault, slot), eph);
  try {
    return { epk: epk.toString("base64"), nonce: nonce.toString("base64"), ct: seal(kek, nonce, slotKey, unwrapAad(vault, slot)).toString("base64") };
  } finally {
    kek.fill(0);
  }
}

/** The slot's key out of a device's answer, with the host's ephemeral key pair; throws when it does not open. */
export function openFromDevice(host: P256Pair, answer: UnwrapAnswer, vault: string, slot: string): Buffer {
  const epk = Buffer.from(answer.epk, "base64");
  const key = keyFrom(host.priv, host.pub, epk, unwrapInfo(vault, slot));
  try {
    const slotKey = unseal(key, Buffer.from(answer.nonce, "base64"), Buffer.from(answer.ct, "base64"), unwrapAad(vault, slot));
    if (slotKey.length !== 32) throw new Error("the device's answer is not a 32-byte key");
    return slotKey;
  } finally {
    key.fill(0);
  }
}
