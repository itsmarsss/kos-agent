import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import type { GenerateRequest } from "../types.js";
import {
  buildAnthropicParams,
  fromAnthropicResponse,
  mapStopReason,
  toAnthropicMessages,
} from "./anthropic.js";

describe("anthropic translators", () => {
  it("builds params with system, tools, adaptive thinking, and effort", () => {
    const req: GenerateRequest = {
      system: "be helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          name: "echo",
          description: "echoes",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
    const params = buildAnthropicParams(req, {
      model: "claude-opus-4-8",
      thinking: "adaptive",
      effort: "high",
    });
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.max_tokens).toBe(16000);
    expect(params.system).toBe("be helpful");
    expect(params.tools?.[0]?.name).toBe("echo");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ effort: "high" });
  });

  it("omits thinking and output_config when not requested", () => {
    const params = buildAnthropicParams(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      { model: "claude-haiku-4-5" },
    );
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toBeUndefined();
  });

  it("maps tool_use, tool_result, and thinking blocks to wire format", () => {
    const raw = { type: "thinking", thinking: "...", signature: "sig" };
    const messages = toAnthropicMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", raw },
          { type: "tool_use", id: "t1", name: "echo", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "ok", isError: false },
        ],
      },
    ]);
    // thinking block echoed back verbatim
    expect(messages[0]?.content[0]).toBe(raw);
    expect(messages[0]?.content[1]).toMatchObject({
      type: "tool_use",
      id: "t1",
      name: "echo",
    });
    expect(messages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      content: "ok",
    });
  });

  it("parses a response with text, tool_use, and thinking", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "hmm", signature: "s" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "u1", name: "echo", input: { a: 2 } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-opus-4-8",
    } as unknown as Anthropic.Messages.Message;

    const res = fromAnthropicResponse(message);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(res.content.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
    const toolUse = res.content[2];
    expect(toolUse).toMatchObject({ type: "tool_use", name: "echo", input: { a: 2 } });
  });

  it("maps stop reasons", () => {
    expect(mapStopReason("end_turn")).toBe("end_turn");
    expect(mapStopReason("stop_sequence")).toBe("end_turn");
    expect(mapStopReason("tool_use")).toBe("tool_use");
    expect(mapStopReason("max_tokens")).toBe("max_tokens");
    expect(mapStopReason("refusal")).toBe("refusal");
  });
});
