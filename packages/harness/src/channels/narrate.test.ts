import { describe, expect, it } from "vitest";

import { shortStory, TurnNarrator } from "./narrate.js";

/**
 * The owner should read what the agent is doing in the order it does it:
 * the words first, then the step they led to, with the answer left for
 * its own message.
 */
describe("narrating a turn", () => {
  const c = "c1";

  it("has nothing to show until a step, then the words before each step and the step", () => {
    const n = new TurnNarrator();
    expect(n.take({ kind: "delta", conversationId: c, of: "text", text: "Let me look at the folder." })).toBe(true);
    expect(n.worthShowing()).toBe(false);
    expect(n.take({ kind: "delta", conversationId: c, of: "reasoning", text: "hidden" })).toBe(false);
    expect(n.take({ kind: "tool-start", conversationId: c, tool: "files.ls", summary: "List projects/x" })).toBe(true);
    expect(n.worthShowing()).toBe(true);
    expect(n.render()).toBe("Let me look at the folder.\n› List projects/x");
    expect(n.take({ kind: "tool-end", conversationId: c, tool: "files.ls", isError: false })).toBe(false);
    n.take({ kind: "delta", conversationId: c, of: "text", text: "Two stale builds. " });
    n.take({ kind: "delta", conversationId: c, of: "text", text: "I'll clear them." });
    n.take({ kind: "tool-start", conversationId: c, tool: "shell.run", summary: "Run: rm -rf build" });
    n.take({ kind: "tool-end", conversationId: c, tool: "shell.run", isError: true });
    expect(n.render()).toBe("Let me look at the folder.\n› List projects/x\nTwo stale builds. I'll clear them.\n› Run: rm -rf build (failed)");
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
    expect(told[0]).toBe("› 22 earlier steps");
    expect(told.slice(1)).toEqual([...steps(30).split("\n").slice(22), "Almost there."]);
    // A folded run counts as all its steps.
    expect(shortStory(`› Look\n› Look\n› Look\n${steps(8)}`).split("\n")[0]).toBe("› 3 earlier steps");
    expect(shortStory(`› Look\n${steps(8)}`).split("\n")[0]).toBe("› 1 earlier step");
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
