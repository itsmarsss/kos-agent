import { describe, expect, it } from "vitest";

import type { Task } from "../models/router.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { runAgent, type Inference } from "./loop.js";
import { ToolRegistry } from "./registry.js";

/** Returns queued responses in order; records the requests it received. */
class ScriptedInference implements Inference {
  requests: GenerateRequest[] = [];
  tasks: Task[] = [];
  constructor(private readonly script: ModelResponse[]) {}
  async generate(task: Task, req: GenerateRequest): Promise<ModelResponse> {
    this.requests.push(req);
    this.tasks.push(task);
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
  it("runs the steps after a screen call on the screen route, and the turn's own after", async () => {
    const reg = addRegistry();
    reg.register({ name: "computer.act", description: "acts", inputSchema: { type: "object", properties: {} } }, () => "clicked");
    const call = (id: string, name: string, input: Record<string, unknown> = {}): ModelResponse => ({
      content: [{ type: "tool_use", id, name, input }],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "mock",
    });
    const done: ModelResponse = { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" };
    const steps = (): ModelResponse[] => [call("1", "computer.act"), call("2", "computer.act"), call("3", "add", { a: 1, b: 2 }), done];
    const on = new ScriptedInference(steps());
    await runAgent(on, reg, "click it", { screen: true });
    expect(on.tasks).toEqual(["reasoning", "screen", "screen", "reasoning"]);
    // Off, every step is the turn's own, as before.
    const off = new ScriptedInference(steps());
    await runAgent(off, reg, "click it");
    expect(off.tasks).toEqual(["reasoning", "reasoning", "reasoning", "reasoning"]);
  });

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

  it("answers with the words after the last step, not the narration beside a call", async () => {
    const step = (text: string, id: string): ModelResponse => ({
      content: [{ type: "text", text }, { type: "tool_use", id, name: "add", input: { a: 1, b: 1 } }],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "mock",
    });
    const inference = new ScriptedInference([
      step("I'll add them.", "t1"),
      step("Now once more.", "t2"),
      { content: [{ type: "text", text: "Sent." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" },
    ]);
    const result = await runAgent(inference, addRegistry(), "add twice");
    expect(result.finalText).toBe("Sent.");
    // The narration stays in the model's own messages, beside its call.
    expect(result.messages[1]!.content[0]).toEqual({ type: "text", text: "I'll add them." });
  });

  it("has no reply when the turn stops or runs out on a step, rather than its narration", async () => {
    const step: ModelResponse = {
      content: [{ type: "text", text: "Checking the board." }, { type: "tool_use", id: "t", name: "add", input: { a: 1, b: 1 } }],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "mock",
    };
    const exhausted = await runAgent(new ScriptedInference([step, step]), addRegistry(), "loop", { maxIterations: 2 });
    expect(exhausted.exhausted).toBe(true);
    expect(exhausted.finalText).toBe("");

    let calls = 0;
    const stopped = await runAgent(new ScriptedInference([step, step]), addRegistry(), "loop", { shouldStop: () => calls++ > 0 });
    expect(stopped.stopped).toBe(true);
    expect(stopped.finalText).toBe("");
  });

  it("answers with what it wrote before a silent save, said once, as the turn's last message", async () => {
    const answer = "The sum is 2. ".repeat(20).trim();
    const step = (text: string, id: string, name: string): ModelResponse => ({
      content: [{ type: "text", text }, { type: "tool_use", id, name, input: { a: 1, b: 1 } }],
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "mock",
    });
    const reg = addRegistry();
    reg.register({ name: "memory.remember", description: "m", inputSchema: { type: "object", properties: {} } }, () => "kept");
    const inference = new ScriptedInference([
      step("I'll add them.", "t1", "add"),
      step(answer, "t2", "memory.remember"),
      { content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" },
    ]);
    const result = await runAgent(inference, reg, "add and remember");
    expect(result.finalText).toBe(answer);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: answer }] });
    // Taken off the step it was written beside, so the history carries it once.
    expect(result.messages[3]!.content).toEqual([{ type: "tool_use", id: "t2", name: "memory.remember", input: { a: 1, b: 1 } }]);
    expect(result.messages[1]!.content[0]).toEqual({ type: "text", text: "I'll add them." });
  });

  it("does not take the words before a save as the reply of a turn cut short", async () => {
    const answer = "The sum is 2. ".repeat(20).trim();
    const reg = addRegistry();
    reg.register({ name: "memory.remember", description: "m", inputSchema: { type: "object", properties: {} } }, () => "kept");
    const save: ModelResponse = { content: [{ type: "text", text: answer }, { type: "tool_use", id: "t1", name: "memory.remember", input: {} }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" };
    const result = await runAgent(new ScriptedInference([save]), reg, "remember", { maxIterations: 1 });
    expect(result.exhausted).toBe(true);
    expect(result.finalText).toBe("");
    expect(result.messages[1]!.content[0]).toEqual({ type: "text", text: answer });
  });

  it("answers with a long answer it posted and the short line after, in the last message", async () => {
    const answer = "The sum is 2. ".repeat(20).trim();
    const reg = addRegistry();
    reg.register({ name: "notify", description: "n", inputSchema: { type: "object", properties: {} } }, () => "Sent.");
    const inference = new ScriptedInference([
      { content: [{ type: "text", text: answer }, { type: "tool_use", id: "t1", name: "notify", input: {} }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" },
      { content: [{ type: "text", text: "Posted above." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" },
    ]);
    const result = await runAgent(inference, reg, "post it");
    expect(result.finalText).toBe(`${answer}\n\nPosted above.`);
    expect(result.messages.at(-1)!.content).toEqual([{ type: "text", text: `${answer}\n\nPosted above.` }]);
    expect(result.messages[1]!.content.some((b) => b.type === "text")).toBe(false);
  });

  it("stamps each message as it is made, so a step keeps its own time", async () => {
    const reg = new ToolRegistry();
    reg.register({ name: "slow", description: "takes a while", inputSchema: { type: "object" } }, async () => {
      await new Promise((done) => setTimeout(done, 40));
      return "done";
    });
    const inference = new ScriptedInference([
      { content: [{ type: "tool_use", id: "t1", name: "slow", input: {} }], stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" },
      { content: [{ type: "text", text: "Finished." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" },
    ]);
    const result = await runAgent(inference, reg, "go");
    const [, called, heard, replied] = result.messages.map((m) => m.at);
    expect(heard! - called!).toBeGreaterThanOrEqual(35);
    expect(replied!).toBeGreaterThanOrEqual(heard!);
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

describe("one tool call at a time", () => {
  function batching(names: string[]): Inference {
    let sent = false;
    return {
      async generate() {
        if (sent) {
          return {
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
            model: "stub",
          };
        }
        sent = true;
        return {
          content: names.map((n, i) => ({
            type: "tool_use" as const,
            id: `c${i}`,
            name: n,
            input: {},
          })),
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "stub",
        };
      },
    };
  }

  function box(ran: string[]) {
    return {
      defs: () => [{ name: "a", description: "", inputSchema: { type: "object" } }],
      execute: async (name: string) => {
        ran.push(name);
        return { content: "ok", isError: false };
      },
    };
  }

  it("runs only the first of a batch", async () => {
    // Asking the provider not to batch is a hint, not a guarantee: with it set,
    // batches of six became mostly one, but twos still came through.
    const ran: string[] = [];
    await runAgent(batching(["a", "b", "c"]), box(ran), "go");
    expect(ran).toEqual(["a"]);
  });

  it("still answers the calls it did not run", async () => {
    // Both providers require a result for every call they made; without one
    // the next request is rejected outright.
    const ran: string[] = [];
    const result = await runAgent(batching(["a", "b", "c"]), box(ran), "go");
    const results = result.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(3);
    expect(JSON.stringify(results)).toContain("one tool call at a time");
  });

  it("runs the whole batch when asked to", async () => {
    const ran: string[] = [];
    await runAgent(batching(["a", "b", "c"]), box(ran), "go", {
      parallelToolCalls: true,
    });
    expect(ran).toEqual(["a", "b", "c"]);
  });
});

describe("stopping a turn", () => {
  function text(body: string): ModelResponse {
    return {
      content: [{ type: "text", text: body }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "stub",
    };
  }

  it("stops a turn that is one model call, not only one with several", async () => {
    /*
     * The check was at the top of the loop, so a stop asked for while the
     * model was answering did nothing until the next round trip -- and a
     * turn that was a single call had none. The request is dropped now, and
     * the provider raising for that reason is a stop, not a failure.
     */
    let stopped = false;
    const inference: Inference = {
      generate: async (_task, req: GenerateRequest) => {
        stopped = true;
        (req.signal as AbortSignal | undefined)?.throwIfAborted?.();
        // The provider raises when the request it was given is dropped.
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    const result = await runAgent(
      inference,
      addRegistry(),
      [{ role: "user", content: [{ type: "text", text: "write an essay" }] }],
      { shouldStop: () => stopped },
    );
    expect(result.stopped).toBe(true);
  });

  it("does not answer a stopped turn with the previous turn's words", async () => {
    /*
     * The history in front of the model holds every earlier answer, so
     * looking for the last assistant message found the one before this turn
     * when this turn had said nothing. Asking a fresh question and stopping
     * it replied with the answer to the question before it.
     */
    const inference: Inference = {
      generate: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    const result = await runAgent(
      inference,
      addRegistry(),
      [
        { role: "user", content: [{ type: "text", text: "say banana" }] },
        { role: "assistant", content: [{ type: "text", text: "banana" }] },
        { role: "user", content: [{ type: "text", text: "write an essay" }] },
      ],
      { shouldStop: () => true },
    );
    expect(result.stopped).toBe(true);
    expect(result.finalText).toBe("");
  });

  it("keeps the half an answer the owner already watched arrive", async () => {
    let stopped = false;
    const inference: Inference = {
      generate: async (_task, req: GenerateRequest) => {
        req.onDelta?.({ kind: "reasoning", text: "planning the essay" });
        req.onDelta?.({ kind: "text", text: "The press began " });
        req.onDelta?.({ kind: "text", text: "in Mainz" });
        stopped = true;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    const result = await runAgent(inference, addRegistry(), "write an essay", { shouldStop: () => stopped, onDelta: () => undefined });
    expect(result.stopped).toBe(true);
    expect(result.finalText).toBe("The press began in Mainz");
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "The press began in Mainz" }], at: expect.any(Number) });
  });

  it("still raises when the call failed for its own reasons", async () => {
    const inference: Inference = {
      generate: async () => {
        throw new Error("provider is down");
      },
    };
    await expect(
      runAgent(inference, addRegistry(), "hello", { shouldStop: () => false }),
    ).rejects.toThrow("provider is down");
  });

  it("passes the signal to the provider so the call can be dropped", async () => {
    const inference = new ScriptedInference([text("done")]);
    const controller = new AbortController();
    await runAgent(inference, addRegistry(), "hi", { signal: controller.signal });
    expect(inference.requests[0]?.signal).toBe(controller.signal);
  });
});
