import { socketUrl } from "./address.js";
import { nonce, sign, verify } from "./keys.js";
import { CallError, PROTOCOL, deviceProof, hostProof, readFrame } from "./protocol.js";

/**
 * The extension's connection to KOS: dialled out, both keys proved, then
 * KOS's calls answered and the extension's events told. Kept up on its own:
 * a dropped connection is dialled again, later each time, except when KOS
 * says it does not know this extension any more.
 */

export type LinkState = "connecting" | "online" | "offline" | "refused";

export interface Hello {
  app: { version: string; platform: "chrome"; os: string };
  consent: "device";
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
}

/** How often the extension says it is still there, which also keeps its worker awake. */
const PING_MS = 20_000;
const RETRY_MAX_MS = 30_000;
/** KOS's close codes: a bad device or signature, and a newer connection of the same device. */
const UNAUTHORIZED = 4003;
const REPLACED = 4009;

export class Link {
  private ws: WebSocket | null = null;
  private ours = "";
  private welcomed = false;
  private stopped = false;
  private retry = 0;
  private ping: ReturnType<typeof setInterval> | undefined;
  private redial: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LinkOptions) {}

  get online(): boolean {
    return this.welcomed;
  }

  start(): void {
    this.stopped = false;
    if (this.ws || this.redial) return;
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
    ws.onmessage = (event: MessageEvent<string>) => void this.receive(ws, String(event.data));
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      clearInterval(this.ping);
      if (event.code === UNAUTHORIZED) return this.options.onState("refused", "KOS does not know this extension any more. Pair it again.");
      if (event.code === REPLACED) return this.options.onState("refused", "Another copy of this extension connected to KOS in its place.");
      this.options.onState("offline");
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
    if (frame.t === "call" && this.welcomed) {
      try {
        this.send({ t: "reply", id: frame.id, ok: true, result: await this.options.onCall(frame.method, frame.params) });
      } catch (err) {
        const code = err instanceof CallError ? err.code : "internal";
        this.send({ t: "reply", id: frame.id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
      }
    }
  }
}
