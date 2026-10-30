import { fromBase64, toBase64 } from "./protocol.js";

/**
 * The extension's own key: an Ed25519 pair made in the browser, the private
 * half never exportable, kept in the extension's IndexedDB (where a key can
 * be stored as a key, not as bytes anyone could copy out).
 */

const DB = "kos";
const STORE = "keys";
const DEVICE_KEY = "device";

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

/** The extension's key pair, made the first time. */
export async function deviceKeys(): Promise<CryptoKeyPair> {
  const kept = await withStore<CryptoKeyPair | undefined>("readonly", (s) => s.get(DEVICE_KEY) as IDBRequest<CryptoKeyPair | undefined>);
  if (kept) return kept;
  const made = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  await withStore("readwrite", (s) => s.put(made, DEVICE_KEY));
  return made;
}

/** A new key the next time one is wanted: unpairing forgets this one. */
export async function forgetKeys(): Promise<void> {
  await withStore("readwrite", (s) => s.delete(DEVICE_KEY));
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
