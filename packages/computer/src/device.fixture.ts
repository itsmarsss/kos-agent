import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { nonce, rawPublicKey, signText, verifyText } from "./keys.js";
import type { Socket } from "./link.js";
import { PROTOCOL_VERSION, deviceProof, hostProof, type DeviceState } from "./protocol.js";

/**
 * A device for tests: a real key, the real handshake, and a script of
 * answers. It stands where KOS Device would, at the other end of a socket
 * pair, so the hub under test is exercised exactly as a device drives it.
 */

type Answer = (params: Record<string, unknown>) => { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };

export class FakeDevice {
  readonly publicKey: string;
  readonly nonce = nonce();
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly answers = new Map<string, Answer>();
  welcome: { name: string; signature: string } | undefined;
  closed: { code: number; reason: string } | undefined;
  state: DeviceState = { consent: "device", permissions: { screen: true, input: true }, displays: [{ id: 1, width: 1512, height: 982, scale: 2, main: true }] };

  private toHost: ((text: string) => void) | undefined;
  private hostClosed: (() => void) | undefined;
  private challenge: string | undefined;

  constructor(
    public id = "dev_test",
    readonly key: KeyObject = generateKeyPairSync("ed25519").privateKey,
  ) {
    this.publicKey = rawPublicKey(key);
    this.answers.set("session.begin", () => ({ ok: true, result: { granted: true, until: Date.now() + 15 * 60_000, space: { width: 1232, height: 800 } } }));
    this.answers.set("screen.capture", () => ({ ok: true, result: { image: "SU1H", mediaType: "image/jpeg", width: 1232, height: 800, cursor: { x: 10, y: 20 }, app: { name: "Finder", bundle: "com.apple.finder" } } }));
    for (const m of ["session.end", "pointer.move", "pointer.click", "pointer.drag", "pointer.scroll", "keys.type", "keys.press"]) {
      this.answers.set(m, () => ({ ok: true, result: { cursor: { x: 1, y: 2 } } }));
    }
  }

  /** The hub's end of the pair. */
  readonly socket: Socket = {
    send: (text) => this.receive(text),
    close: (code, reason) => {
      this.closed = { code, reason };
    },
    onMessage: (handler) => {
      this.toHost = handler;
    },
    onClose: (handler) => {
      this.hostClosed = handler;
    },
  };

  /** What this device would send, said to the hub. */
  send(message: Record<string, unknown>): void {
    this.toHost?.(JSON.stringify(message));
  }

  /** The handshake, signed with this device's key unless told to sign wrong. */
  hello(over: Record<string, unknown> = {}): void {
    if (!this.challenge) throw new Error("no challenge yet");
    this.send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      device: this.id,
      nonce: this.nonce,
      signature: signText(this.key, deviceProof(this.challenge, this.id)),
      app: { version: "0.1.0", platform: "macos", os: "26.4.1" },
      ...this.state,
      ...over,
    });
  }

  /** The device dropping off, as a socket close does. */
  drop(): void {
    this.hostClosed?.();
  }

  event(name: string, data: Record<string, unknown>): void {
    this.send({ t: "event", name, data });
  }

  welcomeVerifies(hostKey: string): boolean {
    return !!this.welcome && verifyText(hostKey, hostProof(this.nonce, this.id), this.welcome.signature);
  }

  private receive(text: string): void {
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (msg.t === "challenge") this.challenge = msg.nonce as string;
    else if (msg.t === "welcome") this.welcome = { name: msg.name as string, signature: msg.signature as string };
    else if (msg.t === "call") {
      const method = msg.method as string;
      const params = msg.params as Record<string, unknown>;
      this.calls.push({ method, params });
      const answer = this.answers.get(method);
      // Answered on the next tick, as a network reply would be.
      queueMicrotask(() => {
        if (!answer) return;
        const a = answer(params);
        this.send(a.ok ? { t: "reply", id: msg.id, ok: true, result: a.result } : { t: "reply", id: msg.id, ok: false, error: { code: a.code, message: a.message } });
      });
    }
  }
}
