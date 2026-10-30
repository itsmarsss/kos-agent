import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Ed25519, as both ends speak it: raw 32-byte public keys and 64-byte
 * signatures, each as standard base64. CryptoKit on the device takes the
 * raw form directly, so nothing here is DER or PEM on the wire.
 */

const toBase64 = (b64url: string): string => Buffer.from(b64url, "base64url").toString("base64");

export function rawPublicKey(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("not an Ed25519 key");
  return toBase64(jwk.x);
}

/** A public key from its raw base64 form, or undefined when it is not 32 bytes. */
export function publicKeyFromRaw(raw: string): KeyObject | undefined {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) return undefined;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" });
  } catch {
    return undefined;
  }
}

export function signText(key: KeyObject, text: string): string {
  return sign(null, Buffer.from(text, "utf8"), key).toString("base64");
}

/** True only for a well-formed signature by that key over exactly that text. */
export function verifyText(publicKey: string, text: string, signature: string): boolean {
  const key = publicKeyFromRaw(publicKey);
  const sig = Buffer.from(signature, "base64");
  if (!key || sig.length !== 64) return false;
  try {
    return verify(null, Buffer.from(text, "utf8"), key, sig);
  } catch {
    return false;
  }
}

export function nonce(): string {
  return randomBytes(32).toString("base64");
}

export interface HostKey {
  privateKey: KeyObject;
  /** The raw public key, as devices pin it. */
  publicKey: string;
}

/**
 * KOS's own key, which devices pin at pairing.
 *
 * Kept outside the workspace, so the agent never reads it: from the
 * environment when the host is given one (a container, whose home does not
 * survive a rebuild), otherwise from a file made on first use with only the
 * owner able to read it. Losing it means re-pairing every device, never a
 * silent new identity they would accept.
 */
export function loadHostKey(options: { env?: string; path: string }): HostKey {
  if (options.env?.trim()) {
    const privateKey = createPrivateKey({ key: Buffer.from(options.env.trim(), "base64"), format: "der", type: "pkcs8" });
    return { privateKey, publicKey: rawPublicKey(privateKey) };
  }
  if (existsSync(options.path)) {
    const privateKey = createPrivateKey(readFileSync(options.path, "utf8"));
    return { privateKey, publicKey: rawPublicKey(privateKey) };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  writeFileSync(options.path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  chmodSync(options.path, 0o600);
  return { privateKey, publicKey: rawPublicKey(privateKey) };
}
