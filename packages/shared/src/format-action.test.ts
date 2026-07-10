import { describe, expect, it } from "vitest";

import {
  detailLines,
  formatApprovalPrompt,
  summarizeAction,
} from "./format-action.js";

describe("summarizeAction", () => {
  it("formats tasks.create_list without raw json", () => {
    const s = summarizeAction("tasks.create_list", {
      name: "Tonight",
      description: "x",
    });
    expect(s).toMatch(/Tonight/);
    expect(s).not.toMatch(/\{/);
  });

  it("accepts JSON string args", () => {
    expect(summarizeAction("files.write", '{"path":"scratch/a.txt"}')).toMatch(
      /scratch\/a\.txt/,
    );
  });

  it("builds a readable approval prompt", () => {
    const t = formatApprovalPrompt(3, "tasks.create_list", { name: "Tonight" });
    expect(t).toMatch(/#3/);
    expect(t).toMatch(/Tonight/);
    expect(t).not.toMatch(/"name"/);
  });

  it("lists detail lines", () => {
    const d = detailLines("tasks.add", { instance: "tonight", title: "hi" });
    expect(d[0]).toMatch(/hi/);
    expect(d.some((l) => l.startsWith("instance:"))).toBe(true);
  });
});
