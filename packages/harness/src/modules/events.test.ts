import { describe, expect, it } from "vitest";

import { EventBus, type KernelEvent } from "./events.js";

describe("the kernel's events", () => {
  const turn: KernelEvent = { kind: "turn:end", conversationId: "c1", projectSlug: null };

  it("tells a subscriber, and only for its kind, until it unsubscribes", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on("turn:end", (e) => {
      seen.push(e.conversationId);
    });
    bus.on("tool:end", () => {
      seen.push("tool");
    });
    bus.emit(turn);
    bus.emit({ kind: "turn:start", conversationId: "c2", projectSlug: null });
    expect(seen).toEqual(["c1"]);
    off();
    bus.emit(turn);
    expect(seen).toEqual(["c1"]);
    expect(bus.count("turn:end")).toBe(0);
  });

  it("hears everything with a star", () => {
    const bus = new EventBus();
    const kinds: string[] = [];
    bus.on("*", (e) => {
      kinds.push(e.kind);
    });
    bus.emit(turn);
    bus.emit({ kind: "module:enabled", name: "m" });
    expect(kinds).toEqual(["turn:end", "module:enabled"]);
  });

  it("contains a handler that throws, or rejects, and reports it", async () => {
    const reported: string[] = [];
    const bus = new EventBus((m) => reported.push(m));
    const after: string[] = [];
    bus.on("turn:end", () => {
      throw new Error("boom");
    });
    bus.on("turn:end", async () => {
      throw new Error("later");
    });
    bus.on("turn:end", () => {
      after.push("still called");
    });
    bus.emit(turn);
    await new Promise((r) => setTimeout(r, 0));
    expect(after).toEqual(["still called"]);
    expect(reported).toEqual(["a module's turn:end handler failed: boom", "a module's turn:end handler failed: later"]);
  });
});
