import { describe, expect, it } from "vitest";

import type { SkillInfo } from "./api.js";
import { matchesSkillView, skillSummary, skillViews } from "./skillviews.js";

const skill = (over: Partial<SkillInfo>): SkillInfo => ({ name: "x", description: "", kind: "prompt", file: "skills/x/SKILL.md", enabled: true, ...over });

describe("which skills to show", () => {
  const board = skill({ name: "board", kind: "script", promoted: true, projects: ["leetcode_daily"] });
  const sync = skill({ name: "sync", kind: "script", promoted: false, enabled: false, projects: ["leetcode_daily"] });
  const receipts = skill({ name: "receipts", kind: "prompt", projects: ["books"] });
  const style = skill({ name: "discord-style", kind: "prompt" });
  const all = [board, sync, receipts, style];

  it("offers the fixed views, then one per project a skill names", () => {
    expect(skillViews(all).map((v) => v.value)).toEqual(["all", "everywhere", "script", "prompt", "promoted", "off", "project:books", "project:leetcode_daily"]);
  });

  it("matches by project, kind and state", () => {
    const names = (view: string): string[] => all.filter((s) => matchesSkillView(s, view)).map((s) => s.name);
    expect(names("all")).toEqual(["board", "sync", "receipts", "discord-style"]);
    expect(names("everywhere")).toEqual(["discord-style"]);
    expect(names("project:leetcode_daily")).toEqual(["board", "sync"]);
    expect(names("script")).toEqual(["board", "sync"]);
    expect(names("prompt")).toEqual(["receipts", "discord-style"]);
    expect(names("promoted")).toEqual(["board"]);
    expect(names("off")).toEqual(["sync"]);
    expect(names("nonsense")).toHaveLength(4);
  });
});

describe("a skill's summary", () => {
  it("is its own words, never the rules a model reads to trigger it", () => {
    const api = "Reference for the Claude API / Anthropic SDK \u2014 model ids, pricing, params, streaming, tool use. TRIGGER \u2014 read BEFORE opening the target file. SKIP only when another provider is used: grep -rE 'openai|langchain'.";
    expect(skillSummary(api)).toBe("Reference for the Claude API / Anthropic SDK \u2014 model ids, pricing, params, streaming, tool use.");
  });

  it("takes the first sentence, and cuts a long one at a word", () => {
    expect(skillSummary("Makes slides. Use it for decks.")).toBe("Makes slides.");
    const long = skillSummary(`Does ${"many things ".repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith("…")).toBe(true);
    expect(skillSummary("")).toBe("");
  });
});
