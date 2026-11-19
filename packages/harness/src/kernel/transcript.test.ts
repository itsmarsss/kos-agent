import { describe, expect, it } from "vitest";

import type { ModelMessage } from "../models/types.js";
import { decidedLine } from "./decisions.js";
import { approvedResult, undoneResult } from "./guarded.js";
import { ownerWords } from "../models/heard.js";
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

  it("says how long the call took, and nothing for one kept before calls were timed", () => {
    const [timed, older] = conversationEvents([
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "shell.run", input: {} }, { type: "tool_use", id: "b", name: "files.read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: "ok", ms: 2_400, waitedMs: 120_000 }, { type: "tool_result", toolUseId: "b", content: "ok" }] },
    ]);
    expect(timed).toMatchObject({ ms: 2_400, waitedMs: 120_000 });
    expect(older).not.toHaveProperty("ms");
    expect(older).not.toHaveProperty("waitedMs");
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

  it("tells a call that waited in the turn how it ended, from its result", () => {
    const call = (id: string, content: string): ModelMessage[] => [
      { role: "assistant", content: [{ type: "tool_use", id, name: "http.fetch", input: { url: "x" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: id, content }] },
    ];
    const events = conversationEvents([
      ...call("t1", undoneResult("denied", "Fetch x")),
      ...call("t2", undoneResult("expired", "Fetch x")),
      ...call("t3", approvedResult({ content: "200", isError: false }).content),
      ...call("t4", "200"),
    ]);
    expect(events.map((e) => (e as { outcome?: string }).outcome)).toEqual(["denied", "lapsed", "approved", undefined]);
  });

  it("marks a queued call that was approved and then failed as failed", () => {
    const events = conversationEvents([
      { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "http.fetch", input: { url: "x" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t9", content: "queued for approval (pending #9); not executed." }] },
      { role: "user", content: [{ type: "text", text: `System: the owner decided on the pending action:\n- ${decidedLine(9, "http.fetch", JSON.stringify({ url: "x" }), { approved: true, isError: true, result: "boom" })}` }] },
    ]);
    expect(events[0]).toMatchObject({ outcome: "approved", isError: true });
  });

  it("tells a queued call its outcome when the decision on it comes", () => {
    const queue = (id: string, n: number): ModelMessage[] => [
      { role: "assistant", content: [{ type: "tool_use", id, name: "files.rm", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: id, content: `queued for approval (pending #${n}); not executed.` }] },
    ];
    const resume = [
      "System: the owner decided on the pending actions:",
      `- ${decidedLine(5, "files.rm", JSON.stringify({ path: "a" }), { approved: true, isError: false, result: "removed" })}`,
      `- ${decidedLine(6, "files.rm", JSON.stringify({ path: "a" }), { approved: false })}`,
    ].join("\n");
    const events = conversationEvents([
      ...queue("t5", 5),
      ...queue("t6", 6),
      ...queue("t7", 7),
      ...queue("t8", 8),
      { role: "user", content: [{ type: "text", text: resume }] },
      { role: "assistant", content: [{ type: "text", text: "@approval:7 (Delete a) lapsed: nobody decided within 24 hours, so nothing was done." }] },
    ]);
    expect(events.slice(0, 4).map((e) => (e as { outcome?: string }).outcome)).toEqual(["approved", "denied", "lapsed", undefined]);
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

describe("words the owner said while a turn ran", () => {
  it("sit after the result that carried them, with the surface they were said on", () => {
    const heard = { mark: "ab12", words: [{ text: "skip the ebooks", via: "discord" }, { text: "and the red one", where: "Said beside their tab at https://shop.test" }] };
    const events = conversationEvents([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser.visit", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "Opened the cart.", heard }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    expect(events.map((e) => (e.kind === "tool" ? e.result : e.kind === "message" ? e : e.kind))).toEqual([
      "Opened the cart.",
      { kind: "message", role: "you", text: "skip the ebooks", origin: { via: "discord" } },
      { kind: "message", role: "you", text: "and the red one" },
      { kind: "message", role: "kos", text: "Done." },
    ]);
  });

  it("are still read from inside a result kept before they had a field", () => {
    const content = `Opened the cart.${ownerWords("ab12cd34", [{ text: "skip the ebooks" }])}`;
    const events = conversationEvents([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser.visit", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content }] },
    ]);
    expect(events.map((e) => (e.kind === "tool" ? e.result : e.kind === "message" ? e.text : e.kind))).toEqual(["Opened the cart.", "skip the ebooks"]);
  });
});

describe("when a message was written", () => {
  it("rides on each message, a note and the words heard mid-turn by the step that took them in", () => {
    const heard = { mark: "ab12", words: [{ text: "and the red one" }] };
    const events = conversationEvents([
      { role: "user", content: [{ type: "text", text: "buy it" }], at: 1_000 },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser.visit", input: {} }], at: 2_000 },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "Opened.", heard }], at: 3_000 },
      { role: "user", content: [{ type: "text", text: "System: the owner denied pending action #4." }], at: 4_000 },
      { role: "assistant", content: [{ type: "text", text: "Done." }], at: 5_000 },
    ]);
    expect(events.flatMap((e) => (e.kind === "message" ? [[e.role, e.at]] : []))).toEqual([
      ["you", 1_000],
      ["you", 3_000],
      ["system", 4_000],
      ["kos", 5_000],
    ]);
  });

  it("is left out for a message kept before messages kept their time", () => {
    const events = conversationEvents([
      { role: "user", content: [{ type: "text", text: "then" }], at: 0 },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
    expect(events.every((e) => !("at" in e))).toBe(true);
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
