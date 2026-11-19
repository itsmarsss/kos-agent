import { KOS_SEED, drawingOf, lookOf, type FaceDrawing, type ThemeMode } from "@kos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Link, type Hello } from "./link.js";
import { PROTOCOL } from "./protocol.js";

/** Verifying KOS's welcome waits on a promise the test settles, as WebCrypto may take its time. */
let settle: (ok: boolean) => void = () => undefined;
vi.mock("./keys.js", () => ({
  nonce: () => "ours",
  sign: async () => "signed",
  verify: () => new Promise<boolean>((resolve) => (settle = resolve)),
}));

class FakeSocket {
  static made: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {}
  frame(frame: Record<string, unknown>): void {
    this.onmessage!({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.made = [];
});

describe("a KOS's line, read in order", () => {
  it("applies the face and theme KOS sends right after its welcome, while the welcome is still being verified", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const faces: FaceDrawing[] = [];
    const themes: ThemeMode[] = [];
    const link = new Link({ url: "http://127.0.0.1:4317", device: "dev_a", onUpdate: () => undefined, hostKey: "k", keys: {} as CryptoKeyPair, hello: () => ({}) as Hello, onCall: async () => ({}), onState: () => undefined, onFace: (f) => void faces.push(f), onTheme: (m) => void themes.push(m.mode) });
    link.start();
    const ws = FakeSocket.made[0]!;
    const face = drawingOf(lookOf(KOS_SEED));
    ws.frame({ t: "challenge", protocol: PROTOCOL, nonce: "theirs" });
    ws.frame({ t: "welcome", name: "KOS", signature: "s" });
    ws.frame({ t: "face", face });
    ws.frame({ t: "theme", mode: "light" });
    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(link.online).toBe(false);
    settle(true);
    await vi.waitFor(() => expect(themes).toEqual(["light"]));
    expect(faces).toEqual([face]);
    expect(link.online).toBe(true);
    link.stop();
  });

  it("reads the frames after one that failed", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const themes: ThemeMode[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let first = true;
    const link = new Link({ url: "http://127.0.0.1:4317", device: "dev_a", onUpdate: () => undefined, hostKey: "k", keys: {} as CryptoKeyPair, hello: () => ({}) as Hello, onCall: async () => ({}), onState: () => undefined, onFace: () => undefined, onTheme: (m) => {
      if (first) {
        first = false;
        throw new Error("drawing failed");
      }
      themes.push(m.mode);
    } });
    link.start();
    const ws = FakeSocket.made[0]!;
    ws.frame({ t: "challenge", protocol: PROTOCOL, nonce: "theirs" });
    ws.frame({ t: "welcome", name: "KOS", signature: "s" });
    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    settle(true);
    ws.frame({ t: "theme", mode: "light" });
    ws.frame({ t: "theme", mode: "dark" });
    await vi.waitFor(() => expect(themes).toEqual(["dark"]));
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    link.stop();
  });

  it("answers calls side by side, so a long one does not hold the frames after it", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const themes: ThemeMode[] = [];
    let finish: () => void = () => undefined;
    const link = new Link({ url: "http://127.0.0.1:4317", device: "dev_a", onUpdate: () => undefined, hostKey: "k", keys: {} as CryptoKeyPair, hello: () => ({}) as Hello, onCall: (method) => (method === "slow" ? new Promise((r) => (finish = () => r({ done: true }))) : Promise.resolve({ quick: true })), onState: () => undefined, onFace: () => undefined, onTheme: (m) => void themes.push(m.mode) });
    link.start();
    const ws = FakeSocket.made[0]!;
    ws.frame({ t: "challenge", protocol: PROTOCOL, nonce: "theirs" });
    ws.frame({ t: "welcome", name: "KOS", signature: "s" });
    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    settle(true);
    ws.frame({ t: "call", id: 1, method: "slow", params: {} });
    ws.frame({ t: "call", id: 2, method: "quick", params: {} });
    ws.frame({ t: "theme", mode: "dark" });
    await vi.waitFor(() => expect(themes).toEqual(["dark"]));
    await vi.waitFor(() => expect(ws.sent.some((f) => JSON.parse(f).id === 2)).toBe(true));
    finish();
    await vi.waitFor(() => expect(ws.sent.some((f) => JSON.parse(f).id === 1)).toBe(true));
    link.stop();
  });

  /** A link through its handshake on a fake socket, its states kept. */
  async function welcomed(verified = true): Promise<{ link: Link; ws: FakeSocket; states: string[] }> {
    vi.stubGlobal("WebSocket", FakeSocket);
    const states: string[] = [];
    const link = new Link({ url: "http://127.0.0.1:4317", device: "dev_a", onUpdate: () => undefined, hostKey: "k", keys: {} as CryptoKeyPair, hello: () => ({}) as Hello, onCall: async () => ({}), onState: (s) => void states.push(s), onFace: () => undefined, onTheme: () => undefined });
    link.start();
    const ws = FakeSocket.made[0]!;
    ws.frame({ t: "challenge", protocol: PROTOCOL, nonce: "theirs" });
    ws.frame({ t: "welcome", name: "KOS", signature: "s" });
    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    settle(verified);
    await vi.waitFor(() => expect(states.at(-1)).toBe(verified ? "online" : "refused"));
    return { link, ws, states };
  }

  it("gives up on a line KOS has gone silent on, though its socket says open, and dials again", async () => {
    // The clock and the pings the test's; the wait to dial again Node's own.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { link, ws, states } = await welcomed();
    try {
      // Pongs keep it up.
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(20_000);
        ws.frame({ t: "pong" });
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(link.online).toBe(true);
      // Then nothing: offline within two pings and a little, and dialled again.
      vi.advanceTimersByTime(60_000);
      expect(link.online).toBe(false);
      expect(states.at(-1)).toBe("offline");
      await vi.waitFor(() => expect(FakeSocket.made.length).toBe(2), { timeout: 3_000 });
    } finally {
      vi.useRealTimers();
      link.stop();
    }
  });

  it("keeps a host that could not prove it is KOS refused, and out of the minute's round", async () => {
    const { link, ws, states } = await welcomed(false);
    ws.onclose!({ code: 1008, reason: "not KOS" });
    expect(states.at(-1)).toBe("refused");
    expect(link.distrusted).toBe(true);
    link.stop();
  });
});
