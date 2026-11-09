import type { FaceDrawing, ThemeMode } from "@kos/shared";

import { socketUrl } from "./address.js";
import { nonce, sign, verify } from "./keys.js";
import { CallError, PROTOCOL, deviceProof, hostProof, readFrame } from "./protocol.js";

/**
 * The extension's connection to KOS: dialled out, both keys proved, then
 * KOS's calls answered and the extension's events told. Kept up on its own:
 * a dropped connection is dialled again, later each time. A line KOS turned
 * away is said with KOS's own reason: "unpaired" when KOS does not take this
 * Chrome's pairing (an id it does not know, a key it did not pair), else
 * "refused". "error" is a line this Chrome could not open on its side.
 */

export type LinkState = "connecting" | "online" | "offline" | "unpaired" | "refused" | "error";

/** Who allows a session: the owner here, or that KOS's approval queue. */
export type Consent = "device" | "kos";

export interface Hello {
  app: { version: string; platform: "chrome"; os: string };
  consent: Consent;
  permissions: Record<string, boolean>;
  displays: never[];
}

export interface LinkOptions {
  url: string;
  device: string;
  hostKey: string;
  keys: CryptoKeyPair;
  hello: () => Hello;
  onCall: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onState: (state: LinkState, detail?: string) => void;
  /** KOS's face, decided there, as it is now and whenever the owner changes it. */
  onFace: (face: FaceDrawing) => void;
  /** The dashboard's theme, as it is now and whenever the owner changes it. */
  onTheme: (mode: ThemeMode) => void;
}

/** How often the extension says it is still there, which also keeps its worker awake. */
const PING_MS = 20_000;
const RETRY_MAX_MS = 30_000;
/** KOS's close codes: a bad device or signature, a newer connection of the same device, another protocol version. */
const UNAUTHORIZED = 4003;
const REPLACED = 4009;
const VERSION = 4010;

/** KOS's reason for closing, as a sentence ("unknown device: ..." reads "Unknown device: ..."), or `otherwise` when it gave none. */
export function said(reason: string, otherwise: string): string {
  const text = reason.trim();
  if (!text) return otherwise;
  return `${text[0]!.toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
}

export class Link {
  private ws: WebSocket | null = null;
  private ours = "";
  private welcomed = false;
  private stopped = false;
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | undefined;
  private redial: ReturnType<typeof setTimeout> | undefined;
  /** Frames are read in the order they came: a welcome still being verified holds the face and theme sent after it. Calls are only started in order. */
  private inbox: Promise<void> = Promise.resolve();

  constructor(private readonly options: LinkOptions) {}

  get online(): boolean {
    return this.welcomed;
  }

  /** Dial now, unless a line is up or being dialled: a wait for the next try is cut short. */
  start(): void {
    this.stopped = false;
    if (this.ws) return;
    clearTimeout(this.redial);
    this.redial = undefined;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.redial);
    this.redial = undefined;
    this.ws?.close(1000, "stopped");
    this.ws = null;
  }

  /**
   * The owner unpaired this Chrome: the KOS on this line forgets it too, as
   * Remove on the dashboard does, rather than listing it offline for good.
   * A socket sends what it was given before it closes, so the word goes first.
   */
  unpair(): void {
    this.send({ t: "unpair" });
    this.stop();
  }

  /** The owner changed who allows a session from this KOS: KOS hears it at once, not at the next connection. */
  consent(consent: Consent): void {
    this.send({ t: "state", consent });
  }

  /** An event for KOS; dropped while offline, since KOS asks again what it needs. */
  event(name: string, data: Record<string, unknown>): void {
    this.send({ t: "event", name, data });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN && (this.welcomed || frame["t"] === "hello")) this.ws.send(JSON.stringify(frame));
  }

  private dial(): void {
    this.options.onState("connecting");
    const ws = new WebSocket(socketUrl(this.options.url));
    this.ws = ws;
    this.welcomed = false;
    this.inbox = Promise.resolve();
    ws.onmessage = (event: MessageEvent<string>) => {
      const text = String(event.data);
      // A frame that fails is said and passed over; the frames after it are still read.
      this.inbox = this.inbox.then(() => this.receive(ws, text)).catch((err: unknown) => console.warn("KOS frame failed", err));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      clearInterval(this.ping);
      // Turned away for good: only pairing again, or another version, puts these right, so they are not dialled again at once.
      if (event.code === UNAUTHORIZED) return this.options.onState("unpaired", said(event.reason, "KOS does not take this Chrome's pairing any more. Pair again."));
      if (event.code === VERSION) return this.options.onState("refused", said(event.reason, "KOS speaks another version of the protocol. Update this extension."));
      // Another copy of this pairing in its place: dialling again would only put that one out in turn.
      if (event.code === REPLACED) return this.options.onState("refused", "Another copy of this extension connected to KOS in its place.");
      // Any other close, KOS's own reason said, is dialled again, later each time.
      this.options.onState("offline", event.code >= 4000 && event.reason ? `${said(event.reason, "")} Trying again.` : undefined);
      if (this.stopped) return;
      const wait = Math.min(RETRY_MAX_MS, 1_000 * 2 ** this.retry++);
      this.redial = setTimeout(() => {
        this.redial = undefined;
        if (!this.stopped) this.dial();
      }, wait);
    };
  }

  private async receive(ws: WebSocket, text: string): Promise<void> {
    const frame = readFrame(text);
    if (!frame) return;
    if (frame.t === "challenge") {
      if (frame.protocol !== PROTOCOL) return ws.close(1002, "protocol");
      this.ours = nonce();
      const signature = await sign(this.options.keys, deviceProof(frame.nonce, this.options.device));
      this.send({ t: "hello", protocol: PROTOCOL, device: this.options.device, nonce: this.ours, signature, ...this.options.hello() });
      return;
    }
    if (frame.t === "welcome") {
      // A host that cannot sign our nonce with the key it gave at pairing is not KOS, whatever its address.
      if (!(await verify(this.options.hostKey, hostProof(this.ours, this.options.device), frame.signature))) {
        this.stopped = true;
        ws.close(1008, "not KOS");
        return this.options.onState("refused", "The KOS at that address could not prove it is the one this extension paired with.");
      }
      this.welcomed = true;
      this.retry = 0;
      this.ping = setInterval(() => this.send({ t: "ping" }), PING_MS);
      this.options.onState("online");
      return;
    }
    if (frame.t === "face" && this.welcomed) return this.options.onFace(frame.face);
    if (frame.t === "theme" && this.welcomed) return this.options.onTheme(frame.mode);
    // Calls are answered side by side: a long one must not hold the frames after it.
    if (frame.t === "call" && this.welcomed) void this.answer(frame.id, frame.method, frame.params);
  }

  private async answer(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      this.send({ t: "reply", id, ok: true, result: await this.options.onCall(method, params) });
    } catch (err) {
      const code = err instanceof CallError ? err.code : "internal";
      this.send({ t: "reply", id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
