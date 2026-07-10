import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import {
  buildOpenAIParams,
  fromOpenAIResponse,
  fromOpenAIToolName,
  mapFinishReason,
  toOpenAIMessages,
  toOpenAIToolName,
} from "./openai.js";

describe("openai translators", () => {
  it("prepends system and converts user text", () => {
    const msgs = toOpenAIMessages("sys", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("converts assistant tool_use into tool_calls", () => {
    const msgs = toOpenAIMessages(undefined, [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "c1", name: "echo", input: { x: 1 } },
        ],
      },
    ]);
    const assistant = msgs[0] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: "c1",
      type: "function",
      function: { name: "echo", arguments: '{"x":1}' },
    });
  });

  it("converts tool_result into a tool message", () => {
    const msgs = toOpenAIMessages(undefined, [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "c1", content: "result" }],
      },
    ]);
    expect(msgs[0]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "result",
    });
  });

  it("builds params with tools and max_completion_tokens", () => {
    const params = buildOpenAIParams(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          { name: "echo", description: "e", inputSchema: { type: "object" } },
        ],
      },
      { model: "gpt-x" },
    );
    expect(params.model).toBe("gpt-x");
    expect(params.max_completion_tokens).toBe(16000);
    expect(params.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "echo" },
    });
  });

  it("encodes dotted tool names for the OpenAI wire format", () => {
    expect(toOpenAIToolName("files.read")).toBe("files__read");
    expect(fromOpenAIToolName("files__read")).toBe("files.read");
    expect(toOpenAIToolName("http.fetch")).toBe("http__fetch");

    const params = buildOpenAIParams(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [
          {
            name: "files.read",
            description: "read a file",
            inputSchema: { type: "object" },
          },
        ],
      },
      { model: "gpt-x" },
    );
    expect(params.tools?.[0]).toMatchObject({
      function: { name: "files__read" },
    });

    const msgs = toOpenAIMessages(undefined, [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "c1",
            name: "files.read",
            input: { path: "a" },
          },
        ],
      },
    ]);
    const assistant = msgs[0] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    const call = assistant.tool_calls?.[0];
    expect(call && "function" in call ? call.function.name : undefined).toBe(
      "files__read",
    );
  });

  it("parses a completion with text and a tool call", () => {
    const completion = {
      choices: [
        {
          message: {
            content: "hello",
            tool_calls: [
              {
                id: "c2",
                type: "function",
                function: { name: "echo", arguments: '{"a":2}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
      model: "gpt-x",
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;

    const res = fromOpenAIResponse(completion);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(res.content[0]).toEqual({ type: "text", text: "hello" });
    expect(res.content[1]).toMatchObject({
      type: "tool_use",
      name: "echo",
      input: { a: 2 },
    });
  });

  it("decodes dotted tool names from OpenAI tool calls", () => {
    const completion = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c3",
                type: "function",
                function: {
                  name: "files__read",
                  arguments: '{"path":"x"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: "gpt-x",
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;

    const res = fromOpenAIResponse(completion);
    expect(res.content[0]).toMatchObject({
      type: "tool_use",
      name: "files.read",
      input: { path: "x" },
    });
  });

  it("maps finish reasons", () => {
    expect(mapFinishReason("stop")).toBe("end_turn");
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
    expect(mapFinishReason("length")).toBe("max_tokens");
    expect(mapFinishReason("content_filter")).toBe("refusal");
    expect(mapFinishReason(null)).toBe("other");
  });
});
