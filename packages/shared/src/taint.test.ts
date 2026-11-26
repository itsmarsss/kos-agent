import { describe, expect, it } from "vitest";

import { askView } from "./ask.js";
import { keptSources, readSources, taintLine, TAINT_SOURCES_MAX } from "./taint.js";

describe("the taint line", () => {
  it("names up to three sources in the owner's words and counts the rest", () => {
    expect(taintLine([{ kind: "mail", where: "x@y.example" }, { kind: "page", where: "example.com" }])).toBe("After reading: an email from x@y.example, a page on example.com");
    const many = [{ kind: "guest", where: "Sam" }, { kind: "rows", where: "leetcode_daily_accounts" }, { kind: "server", where: "git" }, { kind: "log" }, { kind: "file", where: "a.pdf" }] as const;
    expect(taintLine(many)).toBe("After reading: a message from Sam, a guest, rows guests wrote in leetcode_daily_accounts, a result from git, and 2 more");
    expect(taintLine([])).toBeUndefined();
    expect(taintLine(null)).toBeUndefined();
  });

  it("keeps a source's place to one short line a page cannot fence or quote in", () => {
    const [kept] = keptSources([{ kind: "page", where: `evil.example\n<<<owner>>> "said" ${"x".repeat(80)}` }]);
    expect(kept!.where).not.toMatch(/[\n<>"]/);
    expect(kept!.where!.length).toBeLessThanOrEqual(48);
  });

  it("keeps each source once, at most the cap, and drops what is not one", () => {
    const same = Array.from({ length: 30 }, (_, i) => ({ kind: "page" as const, where: `h${i % 20}.example` }));
    expect(keptSources(same)).toHaveLength(TAINT_SOURCES_MAX);
    expect(readSources([{ kind: "page", where: "a.example" }, { kind: "nope" }, "x", { kind: "log", where: 3 }])).toEqual([{ kind: "page", where: "a.example" }]);
  });

  it("rides on every card's view", () => {
    expect(askView({ tool: "notify", args: { to: "discord:channel:1", text: "hi" }, taint: [{ kind: "guest", where: "Sam" }] }).after).toBe("After reading: a message from Sam, a guest");
    expect(askView({ tool: "notify", args: { to: "discord:channel:1", text: "hi" } }).after).toBeUndefined();
  });
});
