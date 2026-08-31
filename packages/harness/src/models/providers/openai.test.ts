import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import type { ModelMessage } from "../types.js";
import {
  buildResponsesParams,
  fromOpenAIToolName,
  fromResponsesResponse,
  toOpenAIToolName,
  toReasoningEffort,
  toResponsesInput,
  toResponsesTools,
} from "./openai.js";

/** A Responses payload with only the fields the mapper reads. */
function response(
  over: Partial<OpenAI.Responses.Response>,
): OpenAI.Responses.Response {
  return {
    model: "gpt-5.5",
    status: "completed",
    output: [],
    ...over,
  } as OpenAI.Responses.Response;
}

describe("openai tool names", () => {
  it("round-trips a dotted name", () => {
    expect(toOpenAIToolName("files.read")).toBe("files__read");
    expect(fromOpenAIToolName("files__read")).toBe("files.read");
  });
});

describe("toResponsesInput", () => {
  it("converts user text", () => {
    expect(
      toResponsesInput([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
    ).toEqual([{ role: "user", content: "hi" }]);
  });

  it("splits an assistant turn into text and function calls", () => {
    const items = toResponsesInput([
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "c1", name: "files.read", input: { x: 1 } },
        ],
      },
    ]);
    expect(items).toEqual([
      { role: "assistant", content: "calling" },
      {
        type: "function_call",
        call_id: "c1",
        name: "files__read",
        arguments: JSON.stringify({ x: 1 }),
      },
    ]);
  });

  it("carries a tool result back under the same call id", () => {
    // The call and its result are separate top-level items here, paired only
    // by call_id. Losing either leaves a call the model never saw answered.
    expect(
      toResponsesInput([
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }],
        },
      ]),
    ).toEqual([{ type: "function_call_output", call_id: "c1", output: "ok" }]);
  });

  it("keeps a whole exchange in order", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "ping", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "c1", content: "pong" }],
      },
    ];
    const kinds = toResponsesInput(messages).map((item) => {
      const i = item as { type?: string; role?: string };
      return i.type ?? i.role;
    });
    expect(kinds).toEqual(["user", "function_call", "function_call_output"]);
  });
});

describe("buildResponsesParams", () => {
  const req = {
    system: "sys",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };

  it("puts the system prompt in instructions", () => {
    expect(buildResponsesParams(req, { model: "gpt-5.5" }).instructions).toBe("sys");
  });

  it("omits reasoning when the spec asks for no effort", () => {
    // A non-reasoning model rejects the field outright, so it must not be
    // sent by default.
    expect(buildResponsesParams(req, { model: "gpt-4.1" }).reasoning).toBeUndefined();
  });

  it("sends reasoning when the spec sets an effort", () => {
    expect(
      buildResponsesParams(req, { model: "gpt-5.5", effort: "high" }).reasoning,
    ).toEqual({ effort: "high" });
  });

  it("maps efforts above OpenAI's top setting onto high", () => {
    expect(toReasoningEffort("max")).toBe("high");
    expect(toReasoningEffort("xhigh")).toBe("high");
    expect(toReasoningEffort("low")).toBe("low");
  });

  it("flattens tools and encodes their names", () => {
    const tools = toResponsesTools([
      { name: "files.read", description: "read", inputSchema: { type: "object" } },
    ]);
    expect(tools?.[0]).toMatchObject({ type: "function", name: "files__read" });
  });
});

describe("fromResponsesResponse", () => {
  it("reads output text", () => {
    const res = fromResponsesResponse(
      response({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        ] as unknown as OpenAI.Responses.Response["output"],
      }),
    );
    expect(res.content).toEqual([{ type: "text", text: "hello" }]);
    expect(res.stopReason).toBe("end_turn");
  });

  it("reads a function call and decodes its name", () => {
    const res = fromResponsesResponse(
      response({
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "files__read",
            arguments: '{"path":"a.md"}',
          },
        ] as unknown as OpenAI.Responses.Response["output"],
      }),
    );
    expect(res.content).toEqual([
      { type: "tool_use", id: "c1", name: "files.read", input: { path: "a.md" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
  });

  it("keeps malformed arguments rather than dropping the call", () => {
    const res = fromResponsesResponse(
      response({
        output: [
          { type: "function_call", call_id: "c1", name: "ping", arguments: "{oops" },
        ] as unknown as OpenAI.Responses.Response["output"],
      }),
    );
    expect(res.content[0]).toMatchObject({ input: { _raw: "{oops" } });
  });

  it("reports running out of output tokens", () => {
    expect(
      fromResponsesResponse(
        response({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ).stopReason,
    ).toBe("max_tokens");
  });

  it("reports a refusal", () => {
    expect(
      fromResponsesResponse(
        response({
          output: [
            { type: "message", content: [{ type: "refusal", refusal: "no" }] },
          ] as unknown as OpenAI.Responses.Response["output"],
        }),
      ).stopReason,
    ).toBe("refusal");
  });

  it("carries usage through", () => {
    const res = fromResponsesResponse(
      response({
        usage: { input_tokens: 11, output_tokens: 22 } as OpenAI.Responses.ResponseUsage,
      }),
    );
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });
});
