import { describe, expect, it } from "vitest";

import { ProgressBus, type ProgressEvent } from "./progress.js";

describe("ProgressBus", () => {
  it("delivers to every listener", () => {
    const bus = new ProgressBus();
    const a: ProgressEvent[] = [];
    const b: ProgressEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("stops delivering once unsubscribed", () => {
    const bus = new ProgressBus();
    const seen: ProgressEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    off();
    bus.emit({ kind: "turn-end", conversationId: "c1" });
    expect(seen).toHaveLength(0);
    expect(bus.size).toBe(0);
  });

  it("keeps going when a listener throws", () => {
    // A broken reader is a broken reader, not a broken turn.
    const bus = new ProgressBus();
    const seen: ProgressEvent[] = [];
    bus.subscribe(() => {
      throw new Error("reader blew up");
    });
    bus.subscribe((e) => seen.push(e));
    expect(() => bus.emit({ kind: "turn-end", conversationId: "c1" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});
