import type { Build } from "./builds.js";
import type { HostKey } from "./keys.js";
import { nonce, signText, verifyHere, verifyText } from "./keys.js";
import {
  CLOSE,
  PROTOCOL_VERSION,
  deviceProof,
  hostProof,
  readFrame,
  type AppInfo,
  type DeviceEvent,
  type DeviceState,
  type Hello,
  type Method,
  type Reply,
} from "./protocol.js";
import type { Device } from "./store.js";

/**
 * One device's connection: the handshake, then calls and their replies.
 *
 * Nothing a device says is acted on until it has signed KOS's nonce with
 * the key it paired with, and KOS has signed its nonce in turn. A frame this
 * side cannot read closes the connection: a device that speaks nonsense is
 * not half-trusted.
 */

/** The little of a WebSocket a link needs, so a test can stand in for one. */
export interface Socket {
  send(text: string): void;
  close(code: number, reason: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

/** A device's answer that was a refusal, with the protocol's code for why. */
export class DeviceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceError";
  }
}

export interface LinkDeps {
  hostKey: HostKey;
  /** The paired device with this id, or undefined for one KOS does not know. */
  lookup(id: string): Device | undefined;
  /** Whether a proved device may use this line; one turned away is refused as `not a phone`. Every device when absent. */
  admit?(device: Device): boolean;
  /** The device dialled loopback, not through a proxy: it may run on the computer KOS runs on. */
  local?: boolean;
  /** The secret a KOS for Mac on this computer proves it is here with; without it, no Mac is taken as here. */
  localKey?: Buffer;
  /** In: both keys proved. */
  onReady(link: DeviceLink): void;
  onState(link: DeviceLink): void;
  onEvent(link: DeviceLink, event: DeviceEvent): void;
  /** The owner unpaired it on the device: only ever its own pairing, on a line it proved. */
  onUnpair(link: DeviceLink): void;
  onClose(link: DeviceLink): void;
  /** A hello turned away, with which check it failed; the line is closed with that check named. */
  onRefused?(refusal: Refusal): void;
  helloTimeoutMs?: number;
}

/** Which check a hello failed. */
export type RefusedCheck = "protocol version" | "unknown device" | "bad signature" | "not a phone";

/** A hello turned away: the id and app it claimed, unproved, and the check it failed. Never its key or signature. */
export interface Refusal {
  device: string;
  app: AppInfo;
  check: RefusedCheck;
}

/** The close reason for each check: the check first, then what it means for the device's owner. */
export const REFUSED_REASON: Record<RefusedCheck, string> = {
  "protocol version": `protocol version: KOS speaks protocol ${PROTOCOL_VERSION}; update this app`,
  "unknown device": "unknown device: KOS has no device by this id; pair again",
  "bad signature": "bad signature: not signed by the key this device paired with; pair again",
  "not a phone": "not a phone: only phones connect over Wi-Fi",
};

const HELLO_TIMEOUT_MS = 10_000;

interface Pending {
  resolve(result: Record<string, unknown>): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DeviceLink {
  private readonly challenge = nonce();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  device: Device | undefined;
  app: AppInfo | undefined;
  /** The build it said it runs, when it said one, and how Chrome says it was installed. */
  build: Build | undefined;
  install: string | undefined;
  private here = false;
  state: DeviceState | undefined;

  constructor(
    private readonly socket: Socket,
    private readonly deps: LinkDeps,
  ) {
    socket.onMessage((text) => this.receive(text));
    socket.onClose(() => this.gone());
    socket.send(JSON.stringify({ t: "challenge", protocol: PROTOCOL_VERSION, nonce: this.challenge }));
    this.helloTimer = setTimeout(() => this.close(CLOSE.malformed, "no hello"), deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
  }

  /** On the computer KOS runs on, which is where KOS can rebuild it: on loopback with no proxy between, and a Mac proved so. */
  get local(): boolean {
    return this.here;
  }

  get ready(): boolean {
    return this.device !== undefined && !this.closed;
  }

  /** Tell the device something that needs no answer, once it is in. */
  tell(frame: { t: string } & Record<string, unknown>): void {
    if (this.ready) this.socket.send(JSON.stringify(frame));
  }

  /** Ask the device to do something; its result, or a DeviceError with its reason. */
  call(method: Method, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.ready) return Promise.reject(new DeviceError("offline", "the device is offline"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceError("timeout", `the device did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ t: "call", id, method, params }));
    });
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.socket.close(code, reason);
    this.gone();
  }

  private receive(text: string): void {
    if (this.closed) return;
    const frame = readFrame(text);
    if (!frame) return this.close(CLOSE.malformed, "unreadable frame");
    if (!this.device) {
      if (frame.t !== "hello") return this.close(CLOSE.malformed, "hello first");
      const device = this.admit(frame);
      if (typeof device === "string") {
        this.deps.onRefused?.({ device: frame.device, app: frame.app, check: device });
        return this.close(device === "protocol version" ? CLOSE.version : CLOSE.unauthorized, REFUSED_REASON[device]);
      }
      clearTimeout(this.helloTimer);
      this.device = device;
      this.app = frame.app;
      this.build = frame.build;
      this.install = frame.install;
      // A Mac is reinstalled from here, so its word alone is not enough: it proves it can read this computer's secret.
      const mac = device.platform === "macos";
      this.here = this.deps.local === true && (!mac || (this.deps.localKey !== undefined && verifyHere(this.deps.localKey, this.challenge, device.id, frame.here)));
      this.state = { consent: frame.consent, permissions: frame.permissions, displays: frame.displays };
      const signature = signText(this.deps.hostKey.privateKey, hostProof(frame.nonce, device.id));
      this.socket.send(JSON.stringify({ t: "welcome", name: device.name, signature }));
      this.deps.onReady(this);
      return;
    }
    switch (frame.t) {
      case "hello":
        return this.close(CLOSE.malformed, "hello twice");
      case "reply":
        return this.settle(frame);
      case "state":
        this.state = {
          consent: frame.consent ?? this.state!.consent,
          permissions: frame.permissions ?? this.state!.permissions,
          displays: frame.displays ?? this.state!.displays,
        };
        return this.deps.onState(this);
      case "event":
        return this.deps.onEvent(this, frame);
      case "ping":
        this.socket.send(JSON.stringify({ t: "pong" }));
        return;
      case "unpair":
        return this.deps.onUnpair(this);
    }
  }

  /** The paired device a hello proves it is, or the first check it fails. */
  private admit(hello: Hello): Device | RefusedCheck {
    if (hello.protocol !== PROTOCOL_VERSION) return "protocol version";
    const device = this.deps.lookup(hello.device);
    if (!device) return "unknown device";
    if (!verifyText(device.publicKey, deviceProof(this.challenge, hello.device), hello.signature)) return "bad signature";
    // Asked only of a device that proved itself, so an unknown one learns nothing of what this line takes.
    return this.deps.admit && !this.deps.admit(device) ? "not a phone" : device;
  }

  private settle(reply: Reply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result ?? {});
    else pending.reject(new DeviceError(reply.error?.code ?? "internal", reply.error?.message || "the device refused"));
  }

  private gone(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DeviceError("offline", "the device went offline"));
    }
    this.pending.clear();
    this.deps.onClose(this);
  }
}
