import { describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ModelMessage, ModelResponse } from "../models/types.js";
import { COMPACTED_PREFIX, compactHistory } from "./compact.js";

/**
 * Compacting a conversation.
 *
 * The failure worth guarding is the quiet one: a compaction that returns
 * nothing useful and replaces a real history with it is a /clear the owner did
 * not ask for, and they would only find out later when KOS had forgotten
 * something it was told.
 */

function reply(text: string): ModelResponse {
  return {
    content: text ? [{ type: "text", text }] : [],
    stopReason: "end_turn",
  } as ModelResponse;
}

function fakeInference(response: ModelResponse): Inference & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    generate: vi.fn(async (_task, req) => {
      for (const m of req.messages) {
        for (const b of m.content) if (b.type === "text") seen.push(b.text);
      }
      return response;
    }),
  } as unknown as Inference & { seen: string[] };
}

function history(n: number): ModelMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `message ${i}` }],
  }));
}

describe("compacting a conversation", () => {
  it("replaces the history with one message carrying the summary", async () => {
    const inference = fakeInference(reply("Built the tracker. Owner prefers dark themes."));
    const result = await compactHistory(inference, history(10));

    expect(result).not.toBeNull();
    expect(result?.compacted).toBe(10);
    expect(result?.messages).toHaveLength(1);
    expect(result?.messages[0]?.role).toBe("user");
    const text = result?.messages[0]?.content[0];
    expect(text?.type === "text" && text.text).toContain(COMPACTED_PREFIX);
    expect(text?.type === "text" && text.text).toContain("dark themes");
  });

  /*
   * The one that matters. An empty answer replacing a real history is a
   * silent /clear: the caller stores the result, the owner is told it was
   * compacted, and everything is gone.
   */
  it("refuses to replace a history with an empty summary", async () => {
    expect(await compactHistory(fakeInference(reply("")), history(10))).toBeNull();
    expect(await compactHistory(fakeInference(reply("   \n  ")), history(10))).toBeNull();
  });

  it("does not bother when there is barely anything to compact", async () => {
    const inference = fakeInference(reply("a summary"));
    expect(await compactHistory(inference, history(2))).toBeNull();
    expect(inference.generate).not.toHaveBeenCalled();
  });

  describe("what the summariser is shown", () => {
    it("includes tool calls and their results, not just the talking", async () => {
      const inference = fakeInference(reply("summary"));
      await compactHistory(inference, [
        ...history(2),
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "1", name: "sites.create", input: { name: "tracker" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "1", content: "Created sites/tracker/" },
          ],
        },
      ] as ModelMessage[]);

      const shown = inference.seen.join("\n");
      // The names and ids are the part worth keeping: a summary that says "a
      // site was made" and not which one cannot be worked from.
      expect(shown).toContain("sites.create");
      expect(shown).toContain("tracker");
      expect(shown).toContain("Created sites/tracker/");
    });

    it("marks a failed tool result as failed", async () => {
      const inference = fakeInference(reply("summary"));
      await compactHistory(inference, [
        ...history(3),
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "1", content: "no such table", isError: true },
          ],
        },
      ] as ModelMessage[]);
      expect(inference.seen.join("\n")).toContain("(error)");
    });
  });
});
