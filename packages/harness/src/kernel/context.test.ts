import { describe, expect, it } from "vitest";

import {
  assembleSystemPrompt,
  TURN_CONTEXT_HEADER,
  withoutTurnContext,
  channelGuidance,
  inferScopeTags,
} from "./context.js";
import { DEFAULT_PROFILE } from "./profile.js";

describe("assembleSystemPrompt", () => {
  it("includes profile, projects, and memory", () => {
    const prompt = assembleSystemPrompt({
      baseSystem: "You are KOS.",
      profile: DEFAULT_PROFILE,
      projects: [
        {
          id: 1,
          name: "Budget",
          slug: "budget",
          type: "tracker",
          status: "active",
          description: "household",
          module: "budget",
          createdAt: 0,
          lastTouchedAt: 0,
        },
      ],
      recall: {
        facts: [
          {
            id: 1,
            userId: "owner",
            key: "currency",
            value: "USD",
            kind: "preference",
            source: null,
      tags: [],
      pinned: false,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        episodes: [],
      },
    });
    /*
     * The fixed half carries everything that does not change between turns,
     * so it is identical every time and can be served from cache. What was
     * recalled for this message is handed back separately, to ride on the
     * turn rather than in front of the tools.
     */
    expect(prompt.system).toMatch(/You are KOS/);
    expect(prompt.system).toMatch(/budget/);
    expect(prompt.system).toMatch(/systems\.migrate/);
    expect(prompt.system).not.toMatch(/currency: USD/);

    expect(prompt.turnContext).toMatch(/currency: USD/);
    expect(prompt.turnContext).toContain(TURN_CONTEXT_HEADER);
  });

  it("hands back no turn context when nothing was recalled", () => {
    const prompt = assembleSystemPrompt({
      baseSystem: "You are KOS.",
      profile: DEFAULT_PROFILE,
      projects: [],
      recall: { facts: [], episodes: [] },
    });
    // An empty block would still be a difference between turns, and one
    // difference is all it takes to end the cached prefix.
    expect(prompt.turnContext).toBe("");
  });
});

describe("keeping recalled context out of the transcript", () => {
  it("takes the block back off before the turn is stored", () => {
    /*
     * Recall is derived from the transcript. Stored back into it, every turn
     * would append a summary of the transcript to the transcript, and the
     * next recall would summarise that.
     */
    const kept = withoutTurnContext([
      {
        role: "user",
        content: [
          { type: "text", text: `${TURN_CONTEXT_HEADER}\n\nremembered things` },
          { type: "text", text: "what the owner actually said" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "the reply" }] },
    ]);

    expect(JSON.stringify(kept)).not.toContain("remembered things");
    expect(JSON.stringify(kept)).toContain("what the owner actually said");
    expect(JSON.stringify(kept)).toContain("the reply");
  });

  it("leaves a message that never carried one alone", () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
    ];
    expect(withoutTurnContext(messages)).toEqual(messages);
  });
});

describe("inferScopeTags", () => {
  it("detects domain keywords", () => {
    expect(inferScopeTags("schedule a cron job")).toContain("cron");
    expect(inferScopeTags("fetch https://example.com")).toContain("http");
    expect(inferScopeTags("create a task list")).toEqual(
      expect.arrayContaining(["tasks", "systems"]),
    );
    // Without this the daemon tools existed and were never offered: they are
    // tagged, and nothing an owner says about an app inferred the tag.
    expect(inferScopeTags("is the api server still running")).toContain("daemons");
    expect(inferScopeTags("show me the logs for that worker")).toContain("daemons");
  });
});

describe("channelGuidance", () => {
  it("says a message can be a card, not only prose", () => {
    // The formatting guidance predated cards and buttons, so on Discord the
    // model was taught how to write a paragraph and never told it could
    // answer with anything else.
    const guidance = channelGuidance("discord") ?? "";
    expect(guidance).toContain("notify sends a message");
    expect(guidance).toContain("card");
    expect(guidance).toContain("buttons");
    // And when not to: a card around a paragraph is a box around a paragraph.
    expect(guidance).toContain("Prose suits everything else");
  });

  it("describes Discord formatting so the model can choose a shape", () => {
    const g = channelGuidance("discord")!;
    expect(g).toContain("headings");
    expect(g).toContain("fenced code blocks");
    // No table syntax exists on Discord; the model must be told, not left to
    // emit a markdown table that renders as garbage.
    expect(g).toContain("no table syntax");
  });

  it("tells the model to match format to the answer", () => {
    expect(channelGuidance("discord")).toMatch(/one-line question gets one line/);
  });

  it("returns nothing for surfaces with no special guidance", () => {
    expect(channelGuidance("cli")).toBeUndefined();
    expect(channelGuidance(undefined)).toBeUndefined();
  });
});
