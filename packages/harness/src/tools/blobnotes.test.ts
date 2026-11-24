import { describe, expect, it } from "vitest";

import { answerCard, askedLine, replySummary, taskSummary } from "./blobnotes.js";

describe("what the asking chat shows of a blob's work", () => {
  it("says the task as the rest of a sentence: its first sentence, lowered unless a name or an acronym", () => {
    expect(taskSummary("Draft the follow-up emails. Then file them.")).toBe("draft the follow-up emails");
    expect(taskSummary("  Check   the\nlisting!  ")).toBe("check the listing");
    expect(taskSummary("PDF the offer letter")).toBe("PDF the offer letter");
    expect(taskSummary("I need a recap of the week")).toBe("I need a recap of the week");
    const long = taskSummary(`find ${"very ".repeat(30)}old mail`);
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long.endsWith("…")).toBe(true);
  });

  it("links the line to the blob's thread", () => {
    expect(askedLine("Follow ups", "c1:owner", "Draft notes for Acme.")).toBe("Asked Follow ups to draft notes for Acme · Open @chat:[c1:owner]");
  });

  it("sums a reply up as prose on one line, never its code, and never a wall", () => {
    const reply = "## Drafted\n\nThree notes are ready.\n\n```kos:email\nto: sam@example.com\n---\nHi Sam\n```\n\nSent none yet.";
    expect(replySummary(reply)).toBe("Drafted Three notes are ready. Sent none yet.");
    expect(replySummary("```ts\nunclosed")).toBe("Done, with nothing to say.");
    expect(replySummary("word ".repeat(200)).length).toBeLessThanOrEqual(281);
  });

  it("draws the answer, or the failure, as a card whose fence nothing inside can close", () => {
    const card = answerCard("Follow ups", "c1:owner", "Draft notes.", { reply: "Done.\n```\nx\n```" });
    expect(card.split("\n")).toEqual([
      "```kos:card",
      "title: Follow ups answered",
      "asked: draft notes",
      "thread: @chat:[c1:owner]",
      "---",
      "> Done.",
      "```",
    ]);
    expect(answerCard("Follow ups", "c1:owner", "Draft notes.", { error: "the model\nwas down" })).toContain("title: Follow ups could not finish\n");
    expect(answerCard("Follow ups", "c1:owner", "Draft notes.", { error: "the model\nwas down" })).toContain("---\n> It failed: the model was down\n```");
  });
});
