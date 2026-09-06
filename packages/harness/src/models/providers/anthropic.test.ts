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
    // A block rather than a string: the only shape that carries a cache
    // breakpoint. The text is unchanged.
    expect(params.system).toEqual([
      { type: "text", text: "be helpful", cache_control: { type: "ephemeral" } },
    ]);
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

describe("anthropic parallel tool calls", () => {
  const req = {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }],
    tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }],
  };

  it("disables parallel use by default", () => {
    expect(buildAnthropicParams(req, { model: "claude-opus-4-8" }).tool_choice).toEqual(
      { type: "auto", disable_parallel_tool_use: true },
    );
  });

  it("leaves it alone when the spec asks for parallel calls", () => {
    expect(
      buildAnthropicParams(req, { model: "claude-opus-4-8", parallelToolCalls: true })
        .tool_choice,
    ).toBeUndefined();
  });
});

describe("telling Anthropic what it may reuse", () => {
  const spec = { provider: "anthropic" as const, model: "claude-opus-5" };

  it("marks tools, system and the end of the conversation", () => {
    /*
     * Every call in an agent loop re-sends the whole prompt, so without a
     * breakpoint a long conversation pays full input price for the same text
     * on every tool round-trip. A cache read is a tenth of that.
     */
    const params = buildAnthropicParams(
      {
        system: "You are KOS.",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ],
        tools: [
          { name: "files.read", description: "read", inputSchema: { type: "object" } },
          { name: "files.write", description: "write", inputSchema: { type: "object" } },
        ],
      },
      spec,
    );

    const system = params.system as { cache_control?: unknown }[];
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });

    // The last tool carries it, so the whole tool block is one cached prefix.
    const tools = params.tools as { cache_control?: unknown }[];
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });

    const last = params.messages.at(-1)!.content as { cache_control?: unknown }[];
    expect(last[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("stays within the four breakpoints Anthropic allows", () => {
    const params = buildAnthropicParams(
      {
        system: "s",
        messages: [
          { role: "user", content: [{ type: "text", text: "a" }] },
          { role: "assistant", content: [{ type: "text", text: "b" }] },
          { role: "user", content: [{ type: "text", text: "c" }] },
        ],
        tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      },
      spec,
    );
    const json = JSON.stringify(params);
    const marks = json.split('"cache_control"').length - 1;
    expect(marks).toBeLessThanOrEqual(4);
  });

  it("does not mark a thinking block, which is the model's own", () => {
    // Echoed back verbatim; adding to it changes something we were handed.
    const params = buildAnthropicParams(
      {
        system: "s",
        messages: [
          { role: "user", content: [{ type: "text", text: "a" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "answer" },
              { type: "thinking", raw: { type: "thinking", thinking: "", signature: "x" } },
            ],
          },
        ],
      },
      spec,
    );
    const blocks = params.messages.at(-1)!.content as {
      type: string;
      cache_control?: unknown;
    }[];
    const thinking = blocks.find((b) => b.type === "thinking");
    expect(thinking?.cache_control).toBeUndefined();
    // It fell back to the text block before it rather than marking nothing.
    expect(blocks.find((b) => b.type === "text")?.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("says nothing about caching when there is no system prompt or tools", () => {
    const params = buildAnthropicParams(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      spec,
    );
    expect(params.system).toBeUndefined();
    expect(params.tools).toBeUndefined();
    // The conversation itself is still worth marking.
    const last = params.messages.at(-1)!.content as { cache_control?: unknown }[];
    expect(last[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
