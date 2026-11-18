import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { askSdkOnce, sdkModelFor, type QueryFn } from "./sdkname.js";

/** A stand-in for the Claude Code process: what it was started with, and the messages it gives. */
function fakeQuery(messages: (options: Options) => AsyncIterable<SDKMessage>): QueryFn & { started: { prompt: string; options: Options }[] } {
  const started: { prompt: string; options: Options }[] = [];
  const run = (params: { prompt: string; options: Options }): AsyncIterable<SDKMessage> => {
    started.push(params);
    return messages(params.options);
  };
  return Object.assign(run, { started });
}

const MODEL = "small-model-from-settings";

const result = (text: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    modelUsage: { [MODEL]: { inputTokens: 120, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.00015 } },
  }) as unknown as SDKMessage;

const ask = (signal = AbortSignal.timeout(6_000)) => ({ system: "Title it.", text: "plan the garden", signal, model: MODEL });

describe("which model a one-shot ask runs on", () => {
  it("is the owner's cheap model when the engine can run it, and the engine's smallest when it cannot", () => {
    expect(sdkModelFor({ provider: "anthropic", spec: { model: "chosen-cheap" } })).toBe("chosen-cheap");
    expect(sdkModelFor({ provider: "openai", spec: { model: "gpt-mini" } })).toBe("haiku");
    expect(sdkModelFor({ provider: "custom", spec: { model: "llama-local" } })).toBe("haiku");
    expect(sdkModelFor(undefined)).toBe("haiku");
  });
});

describe("one short answer from the Agent SDK engine", () => {
  it("runs the model it is given with nothing to act with: no tools, one turn, no session kept, none of the owner's settings", async () => {
    const run = fakeQuery(async function* () {
      yield result("Garden plan");
    });
    const answer = await askSdkOnce(ask(), "/ws", run, { HOME: "/Users/o", USER: "o" });
    expect(answer).toEqual({ text: "Garden plan", models: [{ model: MODEL, inputTokens: 120, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.00015 }] });
    const { prompt, options } = run.started[0]!;
    expect(prompt).toBe("plan the garden");
    expect(options).toMatchObject({
      model: MODEL,
      systemPrompt: "Title it.",
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 1,
      persistSession: false,
      additionalDirectories: [],
    });
    expect(await options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1" } as never)).toMatchObject({ behavior: "deny" });
  });

  it("gives up when the deadline passes, and stops the process", async () => {
    let stopped = false;
    const run = fakeQuery(async function* (options) {
      await new Promise((r) => options.abortController!.signal.addEventListener("abort", r));
      stopped = true;
      yield* [];
    });
    await expect(askSdkOnce(ask(AbortSignal.timeout(20)), "/ws", run, { HOME: "/h" })).rejects.toThrow(/timed out/);
    expect(stopped).toBe(true);
  });

  it("fails on a query that ends without an answer", async () => {
    const error = fakeQuery(async function* () {
      yield { type: "result", subtype: "error_max_turns" } as unknown as SDKMessage;
    });
    await expect(askSdkOnce(ask(), "/ws", error, { HOME: "/h" })).rejects.toThrow(/error_max_turns/);
    const none = fakeQuery(async function* () {
      yield* [];
    });
    await expect(askSdkOnce(ask(), "/ws", none, { HOME: "/h" })).rejects.toThrow(/no result/);
  });
});
