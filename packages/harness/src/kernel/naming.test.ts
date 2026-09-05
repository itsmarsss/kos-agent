import { describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { looksAutoTitled, nameConversation, tidyName } from "./naming.js";

function answers(text: string): Inference {
  return {
    generate: async () => ({
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "stub",
    }),
  } as unknown as Inference;
}

describe("naming a conversation", () => {
  it("takes the name it was given", async () => {
    expect(await nameConversation(answers("3js shooter game"), "q", "a")).toBe(
      "3js shooter game",
    );
  });

  it("strips the wrapping a small model adds", () => {
    expect(tidyName('"Book CRM"')).toBe("Book CRM");
    expect(tidyName("Book CRM.")).toBe("Book CRM");
    expect(tidyName("  Book CRM  \n")).toBe("Book CRM");
  });

  it("refuses an answer that is a sentence about the name", () => {
    // Asked for four words, a small model sometimes answers with a paragraph
    // about the four words. Better a clumsy title than that in the sidebar.
    expect(tidyName("Sure! Here is a good name for the conversation")).toBeNull();
    expect(tidyName("y".repeat(200))).toBeNull();
    expect(tidyName("")).toBeNull();
    // A model answers in the shape it was last asked for, and this would
    // otherwise have become the label on a conversation.
    expect(tidyName('{"facts":[]}')).toBeNull();
    expect(tidyName("<thinking>a name</thinking>")).toBeNull();
  });

  it("keeps the turn when the model cannot be reached", async () => {
    const broken = {
      generate: async () => {
        throw new Error("no model");
      },
    } as unknown as Inference;
    // A clumsy title is a small problem; failing the turn that produced the
    // answer would be a much larger one.
    expect(await nameConversation(broken, "q", "a")).toBeNull();
  });

  it("knows a title nobody chose from one somebody did", () => {
    expect(looksAutoTitled("New conversation")).toBe(true);
    expect(looksAutoTitled("can you build a mini 3js shooter game proj…")).toBe(true);
    expect(looksAutoTitled("anyways, for our book keep track app, can you")).toBe(true);
    // Short, and ending where the owner stopped typing.
    expect(looksAutoTitled("Book CRM")).toBe(false);
    expect(looksAutoTitled("Taxes 2026")).toBe(false);
  });
});
