import { describe, expect, it } from "vitest";

import type { Task } from "../models/router.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { runAgent, type Inference } from "./loop.js";
import { ToolRegistry } from "./registry.js";

/** Returns queued responses in order; records the requests it received. */
class ScriptedInference implements Inference {
  requests: GenerateRequest[] = [];
  constructor(private readonly script: ModelResponse[]) {}
  async generate(_task: Task, req: GenerateRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("scripted inference exhausted");
    return next;
  }
}

function addRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    {
      name: "add",
      description: "adds a and b",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
    },
    (input) => String((input.a as number) + (input.b as number)),
  );
  return reg;
}

describe("runAgent", () => {
  it("runs the tool-call cycle and returns the final text", async () => {
    const inference = new ScriptedInference([
      {
        content: [{ type: "tool_use", id: "t1", name: "add", input: { a: 2, b: 3 } }],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "mock",
      },
      {
        content: [{ type: "text", text: "The sum is 5." }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "mock",
      },
    ]);

    const result = await runAgent(inference, addRegistry(), "add 2 and 3");

    expect(result.iterations).toBe(2);
    expect(result.exhausted).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.finalText).toBe("The sum is 5.");
    // user, assistant(tool_use), user(tool_result), assistant(text)
    expect(result.messages).toHaveLength(4);
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg?.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "t1",
      content: "5",
      isError: false,
    });
  });

  it("passes tool defs to the model when tools are registered", async () => {
    const inference = new ScriptedInference([
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "mock",
      },
    ]);
    await runAgent(inference, addRegistry(), "hi", { system: "be terse" });
    expect(inference.requests[0]?.system).toBe("be terse");
    expect(inference.requests[0]?.tools?.[0]?.name).toBe("add");
  });

  it("returns immediately when the first response has no tool calls", async () => {
    const inference = new ScriptedInference([
      {
        content: [{ type: "text", text: "hello" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "mock",
      },
    ]);
    const result = await runAgent(inference, new ToolRegistry(), "hi");
    expect(result.iterations).toBe(1);
    expect(result.finalText).toBe("hello");
  });

  it("stops at maxIterations when tools never resolve", async () => {
    const toolUse: ModelResponse = {
      content: [{ type: "tool_use", id: "t", name: "add", input: { a: 1, b: 1 } }],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "mock",
    };
    const inference = new ScriptedInference([toolUse, toolUse, toolUse]);
    const result = await runAgent(inference, addRegistry(), "loop", {
      maxIterations: 3,
    });
    expect(result.iterations).toBe(3);
    expect(result.exhausted).toBe(true);
  });

  it("feeds tool errors back so the model can recover", async () => {
    const reg = new ToolRegistry();
    reg.register(
      { name: "boom", description: "fails", inputSchema: { type: "object" } },
      () => {
        throw new Error("kaboom");
      },
    );
    const inference = new ScriptedInference([
      {
        content: [{ type: "tool_use", id: "t1", name: "boom", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "mock",
      },
      {
        content: [{ type: "text", text: "recovered" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "mock",
      },
    ]);
    const result = await runAgent(inference, reg, "go");
    expect(result.finalText).toBe("recovered");
    const toolResult = result.messages[2]?.content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", isError: true });
  });
});
