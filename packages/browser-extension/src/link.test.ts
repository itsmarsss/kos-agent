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
    const link = new Link({ url: "http://127.0.0.1:4317", device: "dev_a", hostKey: "k", keys: {} as CryptoKeyPair, hello: () => ({}) as Hello, onCall: async () => ({}), onState: () => undefined, onFace: (f) => void faces.push(f), onTheme: (m) => void themes.push(m) });
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
    const link = new Link({ url: "http://127.0.0.1:4317", device: "dev_a", hostKey: "k", keys: {} as CryptoKeyPair, hello: () => ({}) as Hello, onCall: async () => ({}), onState: () => undefined, onFace: () => undefined, onTheme: (m) => {
      if (first) {
        first = false;
        throw new Error("drawing failed");
      }
      themes.push(m);
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
});
