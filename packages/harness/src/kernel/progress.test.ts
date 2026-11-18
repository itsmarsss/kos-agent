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

  it("keeps every step of a long turn, the words between two steps as one entry", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    for (let i = 0; i < 300; i++) {
      for (let d = 0; d < 40; d++) bus.emit({ kind: "delta", conversationId: "c1", of: "reasoning", text: "think " });
      bus.emit({ kind: "delta", conversationId: "c1", of: "text", text: "Next." });
      bus.emit({ kind: "tool-start", conversationId: "c1", tool: "computer.act", summary: `step ${i}` });
      bus.emit({ kind: "frame", conversationId: "c1", tool: "computer.act", frameId: i });
      bus.emit({ kind: "tool-end", conversationId: "c1", tool: "computer.act", isError: false });
      if (i % 50 === 0) bus.emit({ kind: "heard", conversationId: "c1", said: `and ${i}` });
    }
    const replay = bus.snapshot();
    const count = (kind: string) => replay.filter((e) => e.kind === kind).length;
    expect(count("turn-start")).toBe(1);
    expect(count("tool-start")).toBe(300);
    expect(count("tool-end")).toBe(300);
    expect(count("frame")).toBe(300);
    expect(count("heard")).toBe(6);
    expect(replay.at(-3)).toMatchObject({ kind: "tool-start", summary: "step 299" });
    // Two runs of words a step at most, and the newest words kept whole.
    expect(count("delta")).toBeLessThanOrEqual(600);
    const deltas = replay.filter((e): e is Extract<ProgressEvent, { kind: "delta" }> => e.kind === "delta");
    expect(deltas.at(-2)!.text).toBe("think ".repeat(40));
    expect(deltas.at(-1)!.text).toBe("Next.");
  });

  it("keeps a step's input whole when small, its long words cut, and none when still too big", () => {
    const bus = new ProgressBus();
    const live: ProgressEvent[] = [];
    bus.subscribe((e) => live.push(e));
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    const big = "x".repeat(10_000);
    bus.emit({ kind: "tool-start", conversationId: "c1", tool: "files.read", summary: "Read a", input: { path: "a.md" } });
    bus.emit({ kind: "tool-start", conversationId: "c1", tool: "files.write", summary: "Write b", input: { path: "b.md", content: big } });
    bus.emit({ kind: "tool-start", conversationId: "c1", tool: "x.y", summary: "Many", input: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, i])) });
    const starts = bus.snapshot().filter((e): e is Extract<ProgressEvent, { kind: "tool-start" }> => e.kind === "tool-start");
    expect(starts[0]!.input).toEqual({ path: "a.md" });
    expect(starts[1]!.input).toEqual({ path: "b.md", content: `${"x".repeat(500)}…` });
    expect(starts[2]!.input).toBeUndefined();
    // A reader watching as it happens still gets each whole.
    expect((live[2] as { input?: { content?: string } }).input?.content).toBe(big);
  });

  it("stamps when a turn began, so a reader joining later keeps its clock", () => {
    const bus = new ProgressBus();
    const seen: ProgressEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const before = Date.now();
    bus.emit({ kind: "turn-start", conversationId: "c1" });
    const at = (seen[0] as { at?: number }).at!;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(bus.snapshot()[0]).toMatchObject({ kind: "turn-start", at });
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
    expect(kept).toBe(40_000);
  });

  it("ignores events for a turn it never saw start", () => {
    const bus = new ProgressBus();
    bus.emit({ kind: "delta", conversationId: "ghost", of: "text", text: "orphan" });
    expect(bus.snapshot()).toEqual([]);
  });

  it("takes secrets out of every event's words before a reader or a late reader sees them", () => {
    const bus = new ProgressBus({ scrub: (text) => text.replaceAll("sk-live", "[secret k]"), longest: () => "sk-live".length });
    const heard: ProgressEvent[] = [];
    bus.subscribe((e) => heard.push(e));
    bus.emit({ kind: "turn-start", conversationId: "c", said: "use sk-live", at: 1 });
    bus.emit({ kind: "tool-start", conversationId: "c", tool: "http.fetch", summary: "fetch ?k=sk-live", input: { headers: { a: "sk-live" } } });
    bus.emit({ kind: "tool-end", conversationId: "c", tool: "http.fetch", isError: false, result: "echo sk-live" });
    bus.emit({ kind: "delta", conversationId: "c", of: "text", text: "it was sk-live" });
    bus.emit({ kind: "heard", conversationId: "c", said: "and sk-live" });
    bus.emit({ kind: "turn-end", conversationId: "c" });
    // Streamed words may arrive in more than one piece: read them joined.
    const words = heard.map((e) => (e.kind === "delta" ? e.text : JSON.stringify(e))).join("");
    expect(words).not.toContain("sk-live");
    expect(words.match(/\[secret k\]/g)).toHaveLength(6);
  });

  it("finds a secret split across streamed pieces, holding back only what could be its start, and lets it go at the turn's end", () => {
    const bus = new ProgressBus({ scrub: (text) => text.replaceAll("sk-live", "[secret k]"), longest: () => "sk-live".length });
    const heard: ProgressEvent[] = [];
    bus.subscribe((e) => heard.push(e));
    bus.emit({ kind: "turn-start", conversationId: "c", at: 1 });
    for (const piece of ["the key is s", "k-l", "ive, and that", " is all"]) bus.emit({ kind: "delta", conversationId: "c", of: "text", text: piece });
    const said = (): string => heard.flatMap((e) => (e.kind === "delta" ? [e.text] : [])).join("");
    expect(said()).not.toContain("sk-");
    // A late reader is replayed the words so far, scrubbed, in one run.
    expect(JSON.stringify(bus.snapshot())).not.toContain("sk-live");
    bus.emit({ kind: "tool-start", conversationId: "c", tool: "x", summary: "x" });
    expect(said()).toBe("the key is [secret k], and that is all");
    // Held words go out before the step that follows them.
    expect(heard.at(-1)?.kind).toBe("tool-start");
    bus.emit({ kind: "delta", conversationId: "c", of: "text", text: "done" });
    bus.emit({ kind: "turn-end", conversationId: "c" });
    expect(said()).toBe("the key is [secret k], and that is alldone");
  });
});
