import { describe, expect, it } from "vitest";

import { CODE_UNSENT, STOP_LAPSES_MS, due, lapsed, queued, readWaiting, stopWith, withCode, type WaitingEvent } from "./waiting.js";

const stop = (kos: string, at: number, chat?: string): WaitingEvent => ({ kos, name: "chat.stop", data: chat ? { chat } : {}, at });

describe("what waits for a line", () => {
  it("keeps a Stop for a chat, and never one that names none", () => {
    expect(queued([], stop("a", 1, "c1"))).toEqual([stop("a", 1, "c1")]);
    const none: WaitingEvent[] = [];
    expect(queued(none, stop("a", 1))).toBe(none);
    const decide: WaitingEvent = { kos: "a", name: "chat.decide", data: { approval: "3", approved: true }, at: 1 };
    expect(queued([], decide)).toEqual([decide]);
  });

  it("sends a KOS back on its line its own, in order, a Stop with how long it waited, and lets a Stop lapse after a minute", () => {
    const now = 100_000;
    const decide: WaitingEvent = { kos: "a", name: "chat.decide", data: { approval: "3", approved: true }, at: 1 };
    const all = [stop("a", now - 5_000, "c1"), stop("b", now, "c2"), stop("a", now - STOP_LAPSES_MS, "c3"), decide];
    const { send, rest } = due(all, "a", now);
    expect(send).toEqual([
      { name: "chat.stop", data: { chat: "c1", waited: 5_000 } },
      { name: "chat.decide", data: { approval: "3", approved: true } },
    ]);
    expect(rest).toEqual([stop("b", now, "c2")]);
    expect(lapsed(true, 0, STOP_LAPSES_MS - 1)).toBe(false);
    expect(lapsed(false, 0, 10 * STOP_LAPSES_MS)).toBe(false);
    expect(stopWith({ chat: "c1" }, 10, 5)).toEqual({ chat: "c1", waited: 0 });
  });

  it("reads back only what it kept", () => {
    expect(readWaiting([stop("a", 1, "c1"), { kos: "a", name: "chat.send", data: {}, at: 1 }, null, "x"])).toEqual([stop("a", 1, "c1")]);
    expect(readWaiting(undefined)).toEqual([]);
  });
});

describe("a yes with a one-time code", () => {
  const decision = { approval: "9", approved: true };
  it("goes at once while KOS's line is up", () => {
    expect(withCode(true, decision, "481926")).toEqual({ send: { approval: "9", approved: true, code: "481926" } });
  });
  it("is given back to the panel, never kept, while the line is down", () => {
    const went = withCode(false, decision, "481926");
    expect(went).toEqual({ unsent: { type: "decide.unsent", approval: "9", why: CODE_UNSENT } });
    expect(JSON.stringify(went)).not.toContain("481926");
  });
});
