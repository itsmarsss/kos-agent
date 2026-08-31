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

describe("summaries for the rest of the toolkit", () => {
  it("names the conversation work is handed to", () => {
    // These reach the reader now that each step is streamed, so the raw
    // key=value dump is no longer good enough.
    expect(summarizeAction("chats.dispatch", { id: "c1", message: "do it" })).toBe(
      "Hand work to conversation c1",
    );
  });

  it("summarises the memory tools", () => {
    expect(summarizeAction("memory.remember", { key: "budget" })).toBe(
      "Remember budget",
    );
    expect(summarizeAction("memory.recall", { query: "deploy" })).toBe(
      "Recall “deploy”",
    );
    expect(summarizeAction("memory.recall", {})).toBe("Recall knowledge");
  });

  it("still falls back for a tool it does not know", () => {
    expect(summarizeAction("mystery.thing", { a: 1 })).toBe("mystery.thing: a=1");
  });
});
