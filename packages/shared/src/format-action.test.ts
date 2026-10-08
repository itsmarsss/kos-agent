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
    expect(
      summarizeAction("chats.congregate", {
        targets: [{ id: "c1", message: "a" }, { title: "B", message: "b" }],
      }),
    ).toBe("Gather from 2 conversations");
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

describe("the risky tools say what they would do", () => {
  it("names the command, the job, the agent and the daemon", () => {
    expect(summarizeAction("shell.run", { command: "git status", cwd: "projects/site" })).toBe("Run: git status (in projects/site)");
    expect(summarizeAction("shell.run", JSON.stringify({ command: "rm -rf build" }))).toBe("Run: rm -rf build");
    expect(summarizeAction("cron.run", { id: 11 })).toBe("Run scheduled job #11 now");
    expect(summarizeAction("builds.run", { dir: "projects/site", task: "Add a footer" })).toBe("Start a coding agent in projects/site: Add a footer");
    expect(summarizeAction("daemons.create", { name: "api", runtime: "node", entry: "server.mjs", args: ["--port", "3000"] })).toBe("Create daemon “api”: node server.mjs --port 3000");
    expect(summarizeAction("systems.project_delete", { project: "old_tracker" })).toBe("Delete project old_tracker and everything in it");
    expect(summarizeAction("chats.project", { name: "Kitchen", goal: "redo the kitchen" })).toBe("Stand up project “Kitchen”: redo the kitchen");
  });

  it("says whose a server's tool is", () => {
    expect(summarizeAction("mcp.browser.navigate", { url: "https://example.com" })).toBe("navigate on browser: url=https://example.com");
    expect(summarizeAction("mcp.browser.snapshot", {})).toBe("snapshot on browser");
  });
});
