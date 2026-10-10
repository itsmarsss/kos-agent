import { describe, expect, it, vi } from "vitest";

import { BrowserLive, parseInput, type BrowserEvent, type StreamSocket } from "./live.js";

/**
 * KOS's end of the browser stream: attaches while someone watches, keeps the
 * newest frame for whoever arrives late, passes input through, and lets go
 * once nobody needs it.
 */

class FakeSocket implements StreamSocket {
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(): void {
    this.onclose?.({});
  }
}

function setup(port: number | null = 4319) {
  const sockets: FakeSocket[] = [];
  const live = new BrowserLive({
    portFor: () => port ?? undefined,
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    lingerMs: 1000,
  });
  return { live, sockets };
}

describe("the browser live view", () => {
  it("attaches on the first watcher, with the frame cap on the url", () => {
    const { live, sockets } = setup();
    expect(live.status()).toMatchObject({ configured: true, attached: false });
    const seen: BrowserEvent[] = [];
    live.subscribe((e) => seen.push(e));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe("ws://127.0.0.1:4319/?maxFps=12");
    expect(seen[0]).toMatchObject({ type: "status", status: { attached: true } });
  });

  it("does nothing when no engine is configured", () => {
    const { live, sockets } = setup(null);
    live.subscribe(() => {});
    expect(sockets).toHaveLength(0);
    expect(live.status().configured).toBe(false);
  });

  it("relays frames, status and urls, and keeps the newest frame for a late watcher", () => {
    const { live, sockets } = setup();
    const first: BrowserEvent[] = [];
    live.subscribe((e) => first.push(e));
    const s = sockets[0]!;
    s.open();
    s.push({ type: "status", connected: true, screencasting: true, viewportWidth: 1280, viewportHeight: 720 });
    s.push({ type: "tabs", tabs: [{ active: false, url: "https://other.example/" }, { active: true, url: "https://example.com/start" }] });
    expect(live.status().url).toBe("https://example.com/start");
    s.push({ type: "url", url: "https://example.com/" });
    s.push({ type: "frame", seq: 7, data: "AAAA", metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 123 } });
    s.push({ type: "frame", seq: 8, data: "BBBB", metadata: { deviceWidth: 1280, deviceHeight: 720, timestamp: 124 } });
    expect(first.filter((e) => e.type === "frame")).toHaveLength(2);
    expect(live.latestFrame()).toEqual({ seq: 8, data: "BBBB", width: 1280, height: 720, at: 124 });
    expect(live.status()).toMatchObject({ connected: true, screencasting: true, url: "https://example.com/", viewport: { width: 1280, height: 720 } });

    const late: BrowserEvent[] = [];
    live.subscribe((e) => late.push(e));
    expect(late.map((e) => e.type)).toEqual(["status", "url", "frame"]);
    expect(late[2]).toMatchObject({ type: "frame", frame: { seq: 8 } });
    expect(sockets).toHaveLength(1);
  });

  it("passes only well-formed input through", () => {
    const { live, sockets } = setup();
    expect(() => live.input({ type: "input_mouse", eventType: "mousePressed", x: 1, y: 2 })).toThrow(/not attached/);
    live.subscribe(() => {});
    live.input({ type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 });
    live.input({ type: "input_keyboard", eventType: "char", text: "a" });
    expect(sockets[0]!.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
      { type: "input_keyboard", eventType: "char", text: "a" },
    ]);
    expect(() => parseInput({ type: "config", maxFps: 1 })).toThrow(/unknown input type/);
    expect(() => parseInput({ type: "input_mouse", eventType: "mousePressed", x: "1", y: 2 })).toThrow(/must be a number/);
    expect(() => parseInput({ type: "input_keyboard", eventType: "keyDown", key: "x".repeat(65) })).toThrow(/short string/);
    expect(() => parseInput({ type: "input_mouse", eventType: "teleport", x: 1, y: 2 })).toThrow(/unknown mouse event/);
  });

  it("lets go a while after the last watcher leaves, and reattaches for the next", () => {
    vi.useFakeTimers();
    try {
      const { live, sockets } = setup();
      const off = live.subscribe(() => {});
      off();
      expect(sockets[0]!.closed).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(sockets[0]!.closed).toBe(true);
      expect(live.status().attached).toBe(false);
      live.subscribe(() => {});
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a socket that opens but never speaks, and one that never opens", () => {
    vi.useFakeTimers();
    try {
      const { live, sockets } = setup();
      live.subscribe(() => {});
      expect(live.status()).toMatchObject({ socket: "connecting", received: 0 });
      vi.advanceTimersByTime(5001);
      expect(sockets[0]!.closed).toBe(true);
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      expect(live.status().socket).toBe("open");
      vi.advanceTimersByTime(5001);
      expect(sockets[1]!.closed).toBe(true);
      vi.advanceTimersByTime(1100);
      expect(sockets).toHaveLength(3);
      sockets[2]!.open();
      sockets[2]!.push({ type: "status", connected: true, screencasting: false });
      vi.advanceTimersByTime(20_000);
      expect(sockets[2]!.closed).toBe(false);
      expect(live.status()).toMatchObject({ socket: "open", received: 1, connected: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches when KOS uses the browser with nobody watching, and tries again after a drop", () => {
    vi.useFakeTimers();
    try {
      const { live, sockets } = setup();
      live.wake();
      expect(sockets).toHaveLength(1);
      sockets[0]!.open();
      sockets[0]!.drop();
      expect(live.status().attached).toBe(false);
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(2);
      // The wake's grace runs out with nobody watching: no third try.
      sockets[1]!.drop();
      vi.advanceTimersByTime(5000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
