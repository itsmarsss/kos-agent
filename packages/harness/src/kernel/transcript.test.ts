import { describe, expect, it } from "vitest";

import type { ModelMessage } from "../models/types.js";
import { decidedLine } from "./decisions.js";
import { conversationEvents, historyEvents, spokenTurns } from "./transcript.js";

const withTool: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "what did I spend" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "t1", name: "sql", input: { sql: "SELECT SUM(amount) FROM tx" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "t1", content: '[{"sum":3410}]' }],
  },
  { role: "assistant", content: [{ type: "text", text: "$3,410." }] },
];

describe("a tool card knows its call", () => {
  it("carries the model's tool-use id, so a frame taken after the step can find it", () => {
    const events = conversationEvents([
      { role: "assistant", content: [{ type: "tool_use", id: "tu_7", name: "browser.visit", input: { url: "https://x" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "tu_7", content: "Opened https://x", isError: false }] },
    ]);
    expect(events[0]).toMatchObject({ kind: "tool", name: "browser.visit", toolUseId: "tu_7", result: "Opened https://x" });
  });
});

describe("conversationEvents", () => {
  it("keeps the tool call in order between the turns", () => {
    const events = conversationEvents(withTool);
    expect(events.map((e) => e.kind)).toEqual([
      "message",
      "message",
      "tool",
      "message",
    ]);
  });

  it("pairs a call with the result that answered it", () => {
    const tool = conversationEvents(withTool).find((e) => e.kind === "tool");
    expect(tool).toMatchObject({
      name: "sql",
      result: '[{"sum":3410}]',
      args: { sql: "SELECT SUM(amount) FROM tx" },
    });
    expect(tool && "summary" in tool && tool.summary).toContain("SELECT SUM");
  });

  it("marks a failed call", () => {
    const events = conversationEvents([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "http.fetch", input: { url: "x" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "host not allowlisted", isError: true },
        ],
      },
    ]);
    expect(events[0]).toMatchObject({ isError: true, result: "host not allowlisted" });
  });

  it("leaves a call with no result pending rather than inventing one", () => {
    const events = conversationEvents([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "sql", input: {} }],
      },
    ]);
    expect(events[0]).toMatchObject({ kind: "tool" });
    expect((events[0] as { result?: string }).result).toBeUndefined();
  });

  it("ignores an orphaned result left by truncation", () => {
    const events = conversationEvents([
      { role: "user", content: [{ type: "tool_result", toolUseId: "gone", content: "x" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(events).toEqual([{ kind: "message", role: "kos", text: "hi" }]);
  });

  it("marks a call held for approval, so it does not read as done", () => {
    const events = conversationEvents([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "http.fetch", input: { url: "x" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content:
              "queued for approval (pending #7); not executed. Tell the user to approve #7.",
          },
        ],
      },
    ]);
    // It did not fail, but it did not happen: without this it renders as "ok".
    expect(events[0]).toMatchObject({ pendingId: "7" });
    expect((events[0] as { isError?: boolean }).isError).toBeUndefined();
  });

  it("shows a resume as a note of what was decided, not as the owner's words", () => {
    const resume = [
      "System: the owner decided on the pending actions:",
      `- ${decidedLine(5, "files.rm", JSON.stringify({ path: "notes/a.md" }), { approved: true, isError: false, result: "removed" })}`,
      `- ${decidedLine(6, "files.rm", JSON.stringify({ path: "notes/b.md" }), { approved: true, isError: true, result: "ENOENT" })}`,
      `- ${decidedLine(7, "files.rm", JSON.stringify({ path: "notes/c.md" }), { approved: false })}`,
      "Carry on with the owner's request now, with these results.",
    ].join("\n");
    const events = conversationEvents([{ role: "user", content: [{ type: "text", text: resume }] }]);
    expect(events).toEqual([
      { kind: "message", role: "system", text: "Approved #5 · Delete notes/a.md; Approved #6 · Delete notes/b.md · failed; Denied #7 · Delete notes/c.md" },
    ]);
  });

  it("ends a decided action at its first outcome, whatever its result says", () => {
    const line = decidedLine(5, "files.rm", JSON.stringify({ path: "notes/a.md" }), { approved: true, isError: false, result: "log: the owner denied this. earlier" });
    const events = conversationEvents([{ role: "user", content: [{ type: "text", text: `System: the owner decided on the pending action:\n- ${line}` }] }]);
    expect(events).toEqual([{ kind: "message", role: "system", text: "Approved #5 · Delete notes/a.md" }]);
  });

  it("shows a resume from before as a note too", () => {
    const resume = [
      "System: the owner decided on the pending actions:",
      "- #5 files.rm: approved and run, SUCCEEDED, result=removed",
      "- #6 shell.run: approved and run, FAILED, result=exit 1",
      "- #7 files.rm: denied by the owner",
      "Continue the owner's prior request now with these results.",
    ].join("\n");
    const events = conversationEvents([{ role: "user", content: [{ type: "text", text: resume }] }]);
    expect(events).toEqual([{ kind: "message", role: "system", text: "Approved #5 · files.rm ran; Approved #6 · shell.run failed; Denied #7 · files.rm" }]);
  });

  it("shows the oldest resumes, one action each, as notes", () => {
    const approved = "System: the owner approved pending action #3.\ntool=sql\noutcome=FAILED\nresult=no such table\nContinue the owner's prior request now.";
    const denied = "System: the owner denied pending action #4. Acknowledge briefly and ask how to proceed without that action.";
    const events = conversationEvents([
      { role: "user", content: [{ type: "text", text: approved }] },
      { role: "user", content: [{ type: "text", text: denied }] },
    ]);
    expect(events).toEqual([
      { kind: "message", role: "system", text: "Approved #3 · sql failed" },
      { kind: "message", role: "system", text: "Denied #4" },
    ]);
  });

  it("leaves a call that really ran without a pending id", () => {
    const events = conversationEvents([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "sql", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "[]" }] },
    ]);
    expect((events[0] as { pendingId?: string }).pendingId).toBeUndefined();
  });

  it("drops empty text rather than emitting blank bubbles", () => {
    const events = conversationEvents([
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ]);
    expect(events).toEqual([]);
  });
});

describe("where a message came from", () => {
  it("rides on the owner's event, and on a message that was only a file", () => {
    const origin = { via: "discord", room: { kind: "channel" as const, id: "c1", name: "leetcode" }, from: { kind: "guest" as const, name: "Ana" } };
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }], origin },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "file", name: "a.txt", text: "x" }], origin: { via: "imessage" } },
    ];
    const events = conversationEvents(messages);
    expect(events[0]).toMatchObject({ kind: "message", role: "you", text: "hi", origin });
    expect(events[1]).not.toHaveProperty("origin");
    expect(events[2]).toMatchObject({ kind: "message", role: "you", attachments: [{ name: "a.txt" }], origin: { via: "imessage" } });
  });
});

describe("spokenTurns", () => {
  it("returns only what was said", () => {
    expect(spokenTurns(withTool)).toEqual([
      { role: "you", text: "what did I spend" },
      { role: "kos", text: "Let me check." },
      { role: "kos", text: "$3,410." },
    ]);
  });
});

describe("historyEvents", () => {
  it("shows every stretch set aside under a line saying so, then the chat as it is", () => {
    const earlier = [
      { at: 1000, why: "cleared" as const, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "old" }] }] },
      { at: 2000, why: "compacted" as const, messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: "long" }] }] },
    ];
    const events = historyEvents(earlier, [{ role: "user", content: [{ type: "text", text: "now" }] }]);
    expect(events.map((e) => (e.kind === "divider" ? `--- ${e.at}` : e.kind === "message" ? e.text : e.kind))).toEqual(["old", "--- 1000", "long", "--- 2000", "now"]);
    expect(events[1]).toMatchObject({ kind: "divider", text: expect.stringContaining("Cleared here") });
    expect(events[3]).toMatchObject({ kind: "divider", text: expect.stringContaining("Compacted here") });
    expect(historyEvents([], [])).toEqual([]);
  });
});
