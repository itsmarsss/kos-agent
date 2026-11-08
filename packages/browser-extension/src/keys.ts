import { fromBase64, toBase64 } from "./protocol.js";

/**
 * The extension's keys: an Ed25519 pair for each KOS it is paired with,
 * made in the browser, the private half never exportable, kept in the
 * extension's IndexedDB (where a key can be stored as a key, not as bytes
 * anyone could copy out). A key of its own for each pairing, so pairing a
 * KOS again never meets the key that KOS already holds, and forgetting one
 * pairing's key leaves the others' alone. Pairings made before that share
 * the one key an older version kept.
 */

const DB = "kos";
const STORE = "keys";
/** The one key an older version kept for every KOS. */
const SHARED_KEY = "device";
const keyOf = (device: string): string => `device:${device}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the key store did not open"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("the key store failed"));
    });
  } finally {
    db.close();
  }
}

const read = (name: string): Promise<CryptoKeyPair | undefined> => withStore("readonly", (s) => s.get(name) as IDBRequest<CryptoKeyPair | undefined>);

/** The key this Chrome proves itself to that KOS with: its own, else the shared one; none when both are gone. */
export async function keysFor(device: string): Promise<CryptoKeyPair | undefined> {
  return (await read(keyOf(device))) ?? (await read(SHARED_KEY));
}

/** A new key for a pairing, kept only once that KOS has taken it. */
export async function newKeys(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
}

export async function keepKeys(device: string, keys: CryptoKeyPair): Promise<void> {
  await withStore("readwrite", (s) => s.put(keys, keyOf(device)));
}

/** A pairing's key forgotten; with `shared`, the older version's one key too, once no pairing is left to use it. */
export async function forgetKeys(device: string, shared: boolean): Promise<void> {
  await withStore("readwrite", (s) => s.delete(keyOf(device)));
  if (shared) await withStore("readwrite", (s) => s.delete(SHARED_KEY));
}

export async function publicKey(keys: CryptoKeyPair): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
}

export async function sign(keys: CryptoKeyPair, text: string): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(text))));
}

/** Whether `signature` over `text` is KOS's, by the key it gave at pairing. */
export async function verify(publicKeyBase64: string, text: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64(publicKeyBase64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(signature), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

/** A fresh nonce for the handshake, base64. */
export function nonce(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}
