import { describe, expect, it } from "vitest";

import type { ModelMessage } from "../models/types.js";
import { conversationEvents, spokenTurns } from "./transcript.js";

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

  it("drops empty text rather than emitting blank bubbles", () => {
    const events = conversationEvents([
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ]);
    expect(events).toEqual([]);
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
