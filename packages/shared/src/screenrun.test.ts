import { describe, expect, it } from "vitest";

import { RunError, ScreenMemory, UNCHANGED, WaitBudget, abortable, actionsOf, digestOf, pause, runActions, type RunAdapter } from "./screenrun.js";

/** A surface whose actions are words: "fail" fails, "hang" runs until the owner stops it, "wait:N" waits N ms. */
function surface(log: string[] = []): RunAdapter<string> {
  return {
    parse: (raw, i) => {
      if (typeof raw !== "string") throw new Error(`step ${i + 1}: must be a word`);
      return raw;
    },
    name: (a) => a.split(":")[0]!,
    perform: async (a, { signal, waits }) => {
      log.push(a);
      if (a === "fail") throw new Error("the button is covered.");
      if (a === "hang") {
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      if (a.startsWith("wait:")) return `waited ${waits.take(Number(a.slice(5)))}ms`;
      return `did ${a}`;
    },
    afterFailure: async () => " The page now offers: @e1 Next.",
    place: "on the page",
  };
}

describe("the shared runner", () => {
  it("runs the actions in order and says what each did", async () => {
    const log: string[] = [];
    expect(await runActions(surface(log), ["a", "b"])).toEqual(["did a", "did b"]);
    expect(log).toEqual(["a", "b"]);
  });

  it("checks every action before the first runs, so a bad run never half-happens", async () => {
    const log: string[] = [];
    await expect(runActions(surface(log), ["a", 7])).rejects.toThrow(/step 2: must be a word/);
    expect(log).toEqual([]);
  });

  it("stops at the step that fails, saying what was done, which step, why and what is there now", async () => {
    const run = runActions(surface(), ["a", "fail", "b"]);
    await expect(run).rejects.toThrow("Done: did a. Step 2 (fail) failed: the button is covered. The page now offers: @e1 Next.");
    await expect(run).rejects.toBeInstanceOf(RunError);
  });

  it("starts nothing once the owner pressed Stop, and stops the step in flight through its signal", async () => {
    const stop = new AbortController();
    const log: string[] = [];
    const run = runActions(surface(log), ["a", "hang", "b"], { signal: stop.signal });
    await pause(5);
    stop.abort();
    await expect(run).rejects.toThrow("Done: did a. Stopped by the owner; step 2 may have finished on the page.");
    expect(log).toEqual(["a", "hang"]);
    await expect(runActions(surface(), ["a"], { signal: stop.signal })).rejects.toThrow("Stopped by the owner before step 1.");
  });

  it("says a step Stop cancels was stopped during it, and claims no more for one it could not", async () => {
    const stop = new AbortController();
    const run = runActions({ ...surface(), cancels: (a) => a === "hang" }, ["hang"], { signal: stop.signal });
    await pause(5);
    stop.abort();
    await expect(run).rejects.toThrow(/^Stopped by the owner during step 1\.$/);
  });

  it("lands Stop in the pause between actions", async () => {
    const stop = new AbortController();
    const log: string[] = [];
    const run = runActions({ ...surface(log), betweenMs: 10_000 }, ["a", "b"], { signal: stop.signal });
    await pause(5);
    stop.abort();
    await expect(run).rejects.toThrow("Done: did a. Stopped by the owner before step 2.");
    expect(log).toEqual(["a"]);
  });

  it("shares one wait budget across a call", async () => {
    expect(await runActions(surface(), ["wait:50000", "wait:50000", "wait:1"])).toEqual(["waited 50000ms", "waited 10000ms", "waited 0ms"]);
    const budget = new WaitBudget(100);
    expect([budget.take(60), budget.take(60), budget.take(1)]).toEqual([60, 40, 0]);
  });

  it("runs out of time at its deadline", async () => {
    const clock = [0, 5, 30];
    const run = runActions(surface(), ["a", "b"], { deadlineMs: 10, now: () => clock.shift() ?? 30 });
    await expect(run).rejects.toThrow("Done: did a. Ran out of time before step 2.");
  });
});

describe("a run's actions", () => {
  it("are `actions`, or `steps` by the older name, never both", () => {
    expect(actionsOf({ actions: [1] }, 5)).toEqual([1]);
    expect(actionsOf({ steps: [2] }, 5)).toEqual([2]);
    expect(() => actionsOf({ actions: [1], steps: [2] }, 5)).toThrow(/not with `steps`/);
    expect(() => actionsOf({}, 5)).toThrow(/actions required/);
    expect(() => actionsOf({ actions: [] }, 5)).toThrow(/actions required/);
    expect(() => actionsOf({ actions: [1, 2, 3] }, 2)).toThrow(/at most 2/);
  });
});

describe("work Stop answers at once", () => {
  it("answers when the owner stops, the work left to end on its own", async () => {
    const stop = new AbortController();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 1_000));
    const answered = abortable(slow, stop.signal);
    stop.abort();
    await expect(answered).rejects.toThrow(/stopped by the owner/);
    expect(await abortable(Promise.resolve("now"))).toBe("now");
  });
});

describe("what a chat was last shown", () => {
  it("says a screen it has seen already has not changed, per chat, until it is forgotten", () => {
    const memory = new ScreenMemory();
    expect(memory.unchanged("c1", "SU1H")).toBe(false);
    expect(memory.unchanged("c1", "SU1H")).toBe(true);
    expect(memory.unchanged("c2", "SU1H")).toBe(false);
    expect(memory.unchanged("c1", "Q0hB")).toBe(false);
    memory.showing("c1", "SU1H");
    expect(memory.unchanged("c1", "SU1H")).toBe(true);
    memory.forget("c1");
    expect(memory.unchanged("c1", "SU1H")).toBe(false);
    expect(UNCHANGED).toBe("The screen has not changed since your last picture.");
  });

  it("tells pictures apart by their content", () => {
    expect(digestOf("abc")).toBe(digestOf("abc"));
    expect(digestOf("abc")).not.toBe(digestOf("abd"));
    expect(digestOf("a".repeat(200_000))).not.toBe(digestOf(`${"a".repeat(199_999)}b`));
  });
});
