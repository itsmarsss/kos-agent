import { describe, expect, it } from "vitest";

import { shortStory, TurnNarrator } from "./narrate.js";

/**
 * The owner should read what the agent is doing in the order it does it:
 * the words first, then the step they led to, with the answer left for
 * its own message.
 */
describe("narrating a turn", () => {
  const c = "c1";

  it("has nothing to show until a step, then the words before each step and the step with its time", () => {
    let now = 1_000_000;
    const n = new TurnNarrator(() => now);
    expect(n.take({ kind: "delta", conversationId: c, of: "text", text: "Let me look at the folder." })).toBe(true);
    expect(n.worthShowing()).toBe(false);
    expect(n.take({ kind: "delta", conversationId: c, of: "reasoning", text: "hidden" })).toBe(false);
    expect(n.take({ kind: "tool-start", conversationId: c, tool: "files.ls", summary: "List projects/x" })).toBe(true);
    expect(n.worthShowing()).toBe(true);
    expect(n.render()).toBe("Let me look at the folder.\n› List projects/x");
    // At work, the time it has taken so far; done, the time it took.
    now += 4_000;
    expect(n.render()).toBe("Let me look at the folder.\n› List projects/x · 4.0s so far");
    expect(n.ticking()).toBe(true);
    expect(n.take({ kind: "tool-end", conversationId: c, tool: "files.ls", isError: false, ms: 4_200 })).toBe(true);
    expect(n.render()).toBe("Let me look at the folder.\n› List projects/x · 4.2s");
    expect(n.ticking()).toBe(false);
    n.take({ kind: "delta", conversationId: c, of: "text", text: "Two stale builds. " });
    n.take({ kind: "delta", conversationId: c, of: "text", text: "I'll clear them." });
    n.take({ kind: "tool-start", conversationId: c, tool: "shell.run", summary: "Run: rm -rf build" });
    now += 75_000;
    n.take({ kind: "tool-end", conversationId: c, tool: "shell.run", isError: true });
    expect(n.render()).toBe("Let me look at the folder.\n› List projects/x · 4.2s\nTwo stale builds. I'll clear them.\n› Run: rm -rf build (failed) · 1m 15s");
  });

  it("says a step waits on the owner, and how long it waited once decided", () => {
    let now = 0;
    const n = new TurnNarrator(() => now);
    n.take({ kind: "tool-start", conversationId: c, tool: "shell.run", summary: "Run: rm -rf build", at: 0 });
    n.waiting();
    expect(n.render()).toBe("› Run: rm -rf build · waiting on you");
    expect(n.ticking()).toBe(false);
    now = 130_000;
    n.take({ kind: "tool-end", conversationId: c, tool: "shell.run", isError: false, ms: 900, waitedMs: 128_000 });
    expect(n.render()).toBe("› Run: rm -rf build · 0.9s · waited 2m 08s for you");
  });

  it("keeps the newest step's picture", () => {
    const n = new TurnNarrator();
    expect(n.take({ kind: "frame", conversationId: c, tool: "browser.act", frameId: 3 })).toBe(true);
    expect(n.take({ kind: "frame", conversationId: c, tool: "browser.act", frameId: 3 })).toBe(false);
    n.take({ kind: "frame", conversationId: c, tool: "browser.act", frameId: 9 });
    expect(n.picture()).toBe(9);
  });

  it("ends the step that ended, of steps running side by side", () => {
    const n = new TurnNarrator(() => 0);
    n.take({ kind: "tool-start", conversationId: c, tool: "files.read", summary: "Read a" });
    n.take({ kind: "tool-start", conversationId: c, tool: "web.fetch", summary: "Fetch b" });
    n.take({ kind: "tool-end", conversationId: c, tool: "files.read", isError: false, ms: 300 });
    expect(n.render()).toBe("› Read a · 0.3s\n› Fetch b");
    // An end with no step of its own running changes nothing.
    expect(n.take({ kind: "tool-end", conversationId: c, tool: "files.read", isError: false })).toBe(false);
  });

  it("says it looks again as a turn carries on in a fresh query, done at its next step", () => {
    const n = new TurnNarrator(() => 0);
    n.take({ kind: "tool-start", conversationId: c, tool: "computer.act", summary: "Open the tab" });
    n.take({ kind: "tool-end", conversationId: c, tool: "computer.act", isError: false, ms: 1_500 });
    expect(n.take({ kind: "fresh", conversationId: c })).toBe(true);
    expect(n.render()).toBe("› Open the tab · 1.5s\n› Looking again");
    n.take({ kind: "tool-start", conversationId: c, tool: "computer.act", summary: "Click Save" });
    expect(n.render()).toBe("› Open the tab · 1.5s\n› Looking again\n› Click Save");
  });

  it("leaves the answer out of the story once the turn is over", () => {
    const n = new TurnNarrator();
    n.take({ kind: "tool-start", conversationId: c, tool: "files.ls", summary: "List x" });
    n.take({ kind: "delta", conversationId: c, of: "text", text: "Here is what I found: three files." });
    expect(n.render()).toBe("› List x\nHere is what I found: three files.");
    expect(n.renderSteps()).toBe("› List x");
    expect(n.take({ kind: "turn-end", conversationId: c })).toBe(false);
    // The turn's end used to flush the answer into the lines, so the story
    // settled with the answer in it and the reply repeated it underneath.
    expect(n.renderSteps()).toBe("› List x");
  });

  it("keeps the tail when the story runs long", () => {
    const n = new TurnNarrator();
    for (let i = 0; i < 80; i++) n.take({ kind: "tool-start", conversationId: c, tool: "t", summary: `Step number ${i} of the long walk` });
    const shown = n.render(200);
    expect(shown.length).toBeLessThanOrEqual(201);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("Step number 79 of the long walk")).toBe(true);
    // Cut at a line, not mid-word, when a line break is near.
    expect(shown.split("\n")[1]!.startsWith("› ")).toBe(true);
  });
});

describe("a short story", () => {
  const steps = (n: number, say = (i: number) => `Step ${i}`): string => Array.from({ length: n }, (_, i) => `› ${say(i + 1)}`).join("\n");

  it("folds a run of a step whatever each took, showing the newest one's time", () => {
    expect(shortStory("› Look · 1.2s\n› Look · 0.8s\n› Look · 3s so far\n› Click (failed) · 0.2s")).toBe("› Look ×3 · 3s so far\n› Click (failed) · 0.2s");
    expect(shortStory("› Run · waiting on you")).toBe("› Run · waiting on you");
    expect(shortStory("› Run · 0.9s · waited 2m 08s for you\n› Run · 1.0s")).toBe("› Run ×2 · 1.0s");
  });

  it("folds a run of the same step into one line", () => {
    expect(shortStory("› Look at the screen\n› Look at the screen\n› Look at the screen\n› Click (failed)\n› Look at the screen")).toBe(
      "› Look at the screen ×3\n› Click (failed)\n› Look at the screen",
    );
    // The agent's words between two like steps keep them apart.
    expect(shortStory("› Look\nStill loading.\n› Look")).toBe("› Look\nStill loading.\n› Look");
  });

  it("folds only steps that are the same whole line", () => {
    const fill = (end: string): string => `› Fill in “${"p".repeat(200)}${end}”`;
    const told = shortStory(`${fill("one")}\n${fill("two")}`).split("\n");
    expect(told).toHaveLength(2);
    expect(told.every((l) => !l.includes("×"))).toBe(true);
    expect(shortStory(`${fill("one")}\n${fill("one")}`)).toBe(`${fill("one").slice(0, 159)}… ×2`);
  });

  it("keeps the last steps under a line counting the rest", () => {
    expect(shortStory(steps(8))).toBe(steps(8));
    const told = shortStory(`I'll start.\n${steps(30)}\nAlmost there.`).split("\n");
    expect(told.slice(0, 2)).toEqual(["I'll start.", "› 22 earlier steps"]);
    expect(told.slice(2)).toEqual([...steps(30).split("\n").slice(22), "Almost there."]);
    // A folded run counts as all its steps.
    expect(shortStory(`› Look\n› Look\n› Look\n${steps(8)}`).split("\n")[0]).toBe("› 3 earlier steps");
    expect(shortStory(`› Look\n${steps(8)}`).split("\n")[0]).toBe("› 1 earlier step");
  });

  it("keeps the agent's own words from before the steps it keeps", () => {
    // What the agent said it would do is not a step, and is never folded away.
    const told = shortStory(`${steps(5)}\nI'm going to delete the old builds.\n${steps(10, (i) => `Later ${i}`)}`).split("\n");
    expect(told).toEqual(["› 5 earlier steps", "I'm going to delete the old builds.", "› 2 earlier steps", ...steps(8, (i) => `Later ${i + 2}`).split("\n")]);
    expect(shortStory(`…Said first.\n${steps(3)}`)).toBe(`› Earlier steps\nSaid first.\n${steps(3)}`);
  });

  it("says when steps before an already cut story are uncounted", () => {
    expect(shortStory(`…${steps(10)}`).split("\n")[0]).toBe("› 2+ earlier steps");
    expect(shortStory(`…${steps(3)}`)).toBe(`› Earlier steps\n${steps(3)}`);
  });

  it("stays well inside a message however long the steps run", () => {
    const long = shortStory(steps(200, (i) => `Type ${i} “${"x".repeat(300)}”`));
    expect(long.split("\n")).toHaveLength(9);
    expect(long.length).toBeLessThan(1500);
  });
});
