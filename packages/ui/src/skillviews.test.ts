import { describe, expect, it } from "vitest";

import type { SkillInfo } from "./api.js";
import { matchesSkillView, skillViews } from "./skillviews.js";

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
