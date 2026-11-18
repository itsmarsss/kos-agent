import { describe, expect, it } from "vitest";

import { priorForSdk } from "../../chat/sdkchat.js";
import type { GenerateRequest, ModelMessage } from "../types.js";
import { buildAnthropicParams } from "./anthropic.js";
import { toChatMessages } from "./compat.js";
import { buildResponsesParams } from "./openai.js";

/** A time no request body may carry: when a message was said is the reader's, never the model's. */
const AT = 1_795_012_345_678;

const history: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "what did I spend" }], at: AT },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "sql", input: { sql: "SELECT 1" } }], at: AT + 1 },
  { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "3410" }], at: AT + 2 },
  { role: "assistant", content: [{ type: "text", text: "$3,410." }], at: AT + 3 },
  { role: "user", content: [{ type: "text", text: "and last month?" }], at: 0 },
];
const req: GenerateRequest = { system: "be brief", messages: history };

/** Every key anywhere in a body, and every number in it. */
function keysAndNumbers(body: unknown): { keys: Set<string>; numbers: Set<number> } {
  const keys = new Set<string>();
  const numbers = new Set<number>();
  const walk = (v: unknown): void => {
    if (typeof v === "number") numbers.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, inner] of Object.entries(v)) {
        keys.add(k);
        walk(inner);
      }
  };
  walk(body);
  return { keys, numbers };
}

describe("when a message was said never reaches a model", () => {
  it.each([
    ["Anthropic", () => buildAnthropicParams(req, { model: "claude-opus-4-8" })],
    ["OpenAI", () => buildResponsesParams(req, { model: "gpt-5.5" })],
    ["an OpenAI-compatible endpoint", () => toChatMessages(req)],
  ])("is left out of %s's request body", (_name, body) => {
    const { keys, numbers } = keysAndNumbers(body());
    expect(keys.has("at")).toBe(false);
    for (const n of [AT, AT + 1, AT + 2, AT + 3]) expect(numbers.has(n)).toBe(false);
  });

  it("is left out of the earlier chat the SDK engine is told", () => {
    const prior = priorForSdk(history, "and last month?");
    expect(prior).toContain("what did I spend");
    expect(prior).not.toMatch(/179501234567\d/);
  });
});
