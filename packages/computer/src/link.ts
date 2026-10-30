import type { HostKey } from "./keys.js";
import { nonce, signText, verifyText } from "./keys.js";
import {
  CLOSE,
  PROTOCOL_VERSION,
  deviceProof,
  hostProof,
  readFrame,
  type AppInfo,
  type DeviceEvent,
  type DeviceState,
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
  /** In: both keys proved. */
  onReady(link: DeviceLink): void;
  onState(link: DeviceLink): void;
  onEvent(link: DeviceLink, event: DeviceEvent): void;
  onClose(link: DeviceLink): void;
  helloTimeoutMs?: number;
}

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

  get ready(): boolean {
    return this.device !== undefined && !this.closed;
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
      if (frame.protocol !== PROTOCOL_VERSION) return this.close(CLOSE.version, `KOS speaks protocol ${PROTOCOL_VERSION}`);
      const device = this.deps.lookup(frame.device);
      if (!device || !verifyText(device.publicKey, deviceProof(this.challenge, frame.device), frame.signature)) {
        return this.close(CLOSE.unauthorized, "not a paired device");
      }
      clearTimeout(this.helloTimer);
      this.device = device;
      this.app = frame.app;
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
    }
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
