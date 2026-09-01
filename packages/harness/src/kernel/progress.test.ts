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

/**
 * Catching up a reader who arrived late.
 *
 * The bus used to remember nothing, so reloading the page during a turn threw
 * away every thought and tool call already streamed: the reader saw an empty
 * space until the turn happened to end.
 */
describe("what a reader who arrives mid-turn is told", () => {
  it("replays the turn so far", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    bus.emit({
      kind: "tool-start",
      conversationId: "c1",
      tool: "sql",
      summary: "SELECT 1",
    });
    bus.emit({ kind: "tool-end", conversationId: "c1", tool: "sql", isError: false });
    bus.emit({ kind: "delta", conversationId: "c1", of: "reasoning", text: "hm" });

    const replay = bus.snapshot();
    expect(replay.map((e) => e.kind)).toEqual([
      "turn-start",
      "tool-start",
      "tool-end",
      "delta",
    ]);
    expect(bus.running()).toEqual(["c1"]);
  });

  /*
   * Once a turn ends the transcript is the record. Replaying it after that
   * would draw the turn twice: once live and once in the message list.
   */
  it("forgets a turn the moment it ends", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    bus.emit({ kind: "delta", conversationId: "c1", of: "text", text: "done" });
    bus.emit({ kind: "turn-end", conversationId: "c1" });
    expect(bus.snapshot()).toEqual([]);
    expect(bus.running()).toEqual([]);
  });

  it("keeps concurrent turns apart", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "turn-start", conversationId: "a" });
    bus.emit({ kind: "turn-start", conversationId: "b" });
    bus.emit({ kind: "delta", conversationId: "a", of: "reasoning", text: "one" });
    bus.emit({ kind: "turn-end", conversationId: "a" });
    expect(bus.running()).toEqual(["b"]);
    expect(bus.snapshot().every((e) => e.conversationId === "b")).toBe(true);
  });

  it("does not grow without bound on a runaway turn", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    for (let i = 0; i < 5000; i++) {
      bus.emit({
        kind: "tool-start",
        conversationId: "c1",
        tool: "loop",
        summary: String(i),
      });
    }
    expect(bus.snapshot().length).toBeLessThan(1000);
  });

  it("caps the reasoning text it keeps", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    for (let i = 0; i < 200; i++) {
      bus.emit({
        kind: "delta",
        conversationId: "c1",
        of: "reasoning",
        text: "x".repeat(1000),
      });
    }
    const kept = bus
      .snapshot()
      .filter((e): e is Extract<typeof e, { kind: "delta" }> => e.kind === "delta")
      .reduce((n, e) => n + e.text.length, 0);
    expect(kept).toBeLessThanOrEqual(41_000);
  });

  it("ignores events for a turn it never saw start", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "delta", conversationId: "ghost", of: "text", text: "orphan" });
    expect(bus.snapshot()).toEqual([]);
  });
});
