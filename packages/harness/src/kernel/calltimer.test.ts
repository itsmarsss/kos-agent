import { describe, expect, it } from "vitest";

import type { ModelMessage } from "../models/types.js";
import { CallTimer } from "./calltimer.js";

describe("timing a call", () => {
  it("counts the run and not the wait for the owner's yes", () => {
    let now = 1_000;
    const timer = new CallTimer(() => now);
    expect(timer.started("t1")).toBe(1_000);
    timer.asked("t1", 7);
    now = 125_400;
    // Asked at 1 100, decided at 121 100: two minutes of the owner's time.
    expect(timer.ended("t1", (id) => (id === 7 ? { requestedAt: 1_100, decidedAt: 121_100 } : undefined))).toEqual({ ms: 4_400, waitedMs: 120_000 });
  });

  it("times a call that never asked by its whole run", () => {
    let now = 0;
    const timer = new CallTimer(() => now);
    timer.started("t2");
    now = 2_400;
    expect(timer.ended("t2", () => undefined)).toEqual({ ms: 2_400 });
  });

  it("leaves a call it did not see start untimed rather than timed wrong", () => {
    const timer = new CallTimer(() => 5);
    expect(timer.ended("unseen", () => undefined)).toEqual({});
    expect(timer.ended(undefined, () => undefined)).toEqual({});
  });

  it("keeps the times onto the calls' results, once", () => {
    let now = 0;
    const timer = new CallTimer(() => now);
    timer.started("t3");
    now = 900;
    timer.ended("t3", () => undefined);
    const turn: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "files.read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t3", content: "ok" }, { type: "tool_result", toolUseId: "old", content: "ok" }] },
    ];
    const kept = timer.stamp(turn);
    expect(kept[1]!.content).toEqual([{ type: "tool_result", toolUseId: "t3", content: "ok", ms: 900 }, { type: "tool_result", toolUseId: "old", content: "ok" }]);
    expect(timer.stamp(turn)).toBe(turn);
  });
});
