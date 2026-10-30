/**
 * The wire between KOS and a device, as docs/computer.md specifies it.
 *
 * Everything here is data and pure functions: what each message looks like,
 * what is signed, and how a frame is read. The device app on the other end
 * is written in another language against the same document, so the shapes
 * are kept literal rather than clever.
 */

export const PROTOCOL_VERSION = 1;

/** The path a device's WebSocket opens. */
export const SOCKET_PATH = "/api/devices/socket";

/** The largest frame either side accepts: a full-screen capture is well under it. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const CLOSE = {
  malformed: 4001,
  unauthorized: 4003,
  replaced: 4009,
  version: 4010,
} as const;

export type Consent = "device" | "kos";

export interface Permissions {
  screen: boolean;
  input: boolean;
}

export interface Display {
  id: number;
  width: number;
  height: number;
  scale: number;
  main: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  os: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Region extends Point, Size {}

/** What a device says it is when it connects, and again (as `state`) when that changes. */
export interface DeviceState {
  consent: Consent;
  permissions: Permissions;
  displays: Display[];
}

export interface Challenge {
  t: "challenge";
  protocol: number;
  nonce: string;
}

export interface Hello extends DeviceState {
  t: "hello";
  protocol: number;
  device: string;
  nonce: string;
  signature: string;
  app: AppInfo;
}

export interface Welcome {
  t: "welcome";
  name: string;
  signature: string;
}

export interface StateUpdate extends Partial<DeviceState> {
  t: "state";
}

export interface Call {
  t: "call";
  id: number;
  method: Method;
  params: Record<string, unknown>;
}

export type ErrorCode =
  | "no_session"
  | "paused"
  | "busy"
  | "denied"
  | "permission"
  | "secure_input"
  | "hidden_app"
  | "bad_request"
  | "internal";

export interface Reply {
  t: "reply";
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: ErrorCode | string; message: string };
}

export type EventName = "session.paused" | "session.resumed" | "session.extended" | "session.ended";

export type EndReason = "owner" | "expired" | "idle" | "quit" | "host";

export interface DeviceEvent {
  t: "event";
  name: EventName | string;
  data: Record<string, unknown>;
}

export type Method =
  | "session.begin"
  | "session.end"
  | "screen.capture"
  | "pointer.move"
  | "pointer.click"
  | "pointer.drag"
  | "pointer.scroll"
  | "keys.type"
  | "keys.press";

/** What a device sends once it is in. */
export type FromDevice = Hello | StateUpdate | Reply | DeviceEvent;

/** What `session.begin` answers when the owner allows it. */
export interface Grant {
  granted: true;
  until: number;
  space: Size;
}

/** What `screen.capture` answers. */
export interface Capture {
  image: string;
  mediaType: string;
  width: number;
  height: number;
  cursor: Point;
  app?: { name: string; bundle?: string };
}

/** The bytes a device signs to prove its key: KOS's nonce, bound to the device's id. */
export function deviceProof(hostNonce: string, deviceId: string): string {
  return `kos-device/${PROTOCOL_VERSION}|device|${hostNonce}|${deviceId}`;
}

/** The bytes KOS signs to prove its key: the device's nonce, bound to the same id. */
export function hostProof(deviceNonce: string, deviceId: string): string {
  return `kos-device/${PROTOCOL_VERSION}|host|${deviceNonce}|${deviceId}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function readPermissions(v: unknown): Permissions | undefined {
  if (!isObject(v) || !isBool(v.screen) || !isBool(v.input)) return undefined;
  return { screen: v.screen, input: v.input };
}

function readDisplays(v: unknown): Display[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Display[] = [];
  for (const d of v) {
    if (!isObject(d)) return undefined;
    const { id, width, height, scale, main } = d;
    if (typeof id !== "number" || typeof width !== "number" || typeof height !== "number" || typeof scale !== "number" || !isBool(main)) return undefined;
    out.push({ id, width, height, scale, main });
  }
  return out;
}

function readConsent(v: unknown): Consent | undefined {
  return v === "device" || v === "kos" ? v : undefined;
}

/**
 * One frame from a device, read and checked. Anything that is not a message
 * this side understands is undefined: the socket is closed as malformed
 * rather than half-trusted.
 */
export function readFrame(text: string): FromDevice | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  switch (raw.t) {
    case "hello": {
      const permissions = readPermissions(raw.permissions);
      const displays = readDisplays(raw.displays);
      const consent = readConsent(raw.consent);
      const app = raw.app;
      if (typeof raw.protocol !== "number" || !isString(raw.device) || !isString(raw.nonce) || !isString(raw.signature)) return undefined;
      if (!permissions || !displays || !consent || !isObject(app) || !isString(app.version) || !isString(app.platform) || !isString(app.os)) return undefined;
      return {
        t: "hello",
        protocol: raw.protocol,
        device: raw.device,
        nonce: raw.nonce,
        signature: raw.signature,
        app: { version: app.version, platform: app.platform, os: app.os },
        consent,
        permissions,
        displays,
      };
    }
    case "state": {
      const update: StateUpdate = { t: "state" };
      if (raw.consent !== undefined) {
        const consent = readConsent(raw.consent);
        if (!consent) return undefined;
        update.consent = consent;
      }
      if (raw.permissions !== undefined) {
        const permissions = readPermissions(raw.permissions);
        if (!permissions) return undefined;
        update.permissions = permissions;
      }
      if (raw.displays !== undefined) {
        const displays = readDisplays(raw.displays);
        if (!displays) return undefined;
        update.displays = displays;
      }
      return update;
    }
    case "reply": {
      if (typeof raw.id !== "number" || !isBool(raw.ok)) return undefined;
      const reply: Reply = { t: "reply", id: raw.id, ok: raw.ok };
      if (isObject(raw.result)) reply.result = raw.result;
      if (isObject(raw.error)) {
        reply.error = { code: String(raw.error.code ?? "internal"), message: String(raw.error.message ?? "") };
      }
      return reply;
    }
    case "event": {
      if (!isString(raw.name) || !isObject(raw.data)) return undefined;
      return { t: "event", name: raw.name, data: raw.data };
    }
    default:
      return undefined;
  }
}
