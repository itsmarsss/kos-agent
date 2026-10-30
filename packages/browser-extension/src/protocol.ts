/**
 * The device protocol, as the extension speaks it (docs/computer.md and
 * docs/browser-extension.md): what KOS may send, read and checked, and the
 * texts each side signs.
 */

export const PROTOCOL = 1;

/** What the extension signs to prove it holds its key. */
export function deviceProof(kosNonce: string, device: string): string {
  return `kos-device/1|device|${kosNonce}|${device}`;
}

/** What KOS signs to prove it holds its key. */
export function hostProof(deviceNonce: string, device: string): string {
  return `kos-device/1|host|${deviceNonce}|${device}`;
}

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type KosFrame =
  | { t: "challenge"; protocol: number; nonce: string }
  | { t: "welcome"; name: string; signature: string }
  | { t: "call"; id: number; method: string; params: Record<string, unknown> }
  | { t: "pong" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A frame from KOS, or nothing when it is not one. */
export function readFrame(text: string): KosFrame | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  switch (raw["t"]) {
    case "challenge":
      return typeof raw["protocol"] === "number" && typeof raw["nonce"] === "string" ? { t: "challenge", protocol: raw["protocol"], nonce: raw["nonce"] } : undefined;
    case "welcome":
      return typeof raw["name"] === "string" && typeof raw["signature"] === "string" ? { t: "welcome", name: raw["name"], signature: raw["signature"] } : undefined;
    case "call":
      return typeof raw["id"] === "number" && typeof raw["method"] === "string"
        ? { t: "call", id: raw["id"], method: raw["method"], params: isRecord(raw["params"]) ? raw["params"] : {} }
        : undefined;
    case "pong":
      return { t: "pong" };
    default:
      return undefined;
  }
}

/** A refusal with a reason KOS can act on. */
export class CallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
