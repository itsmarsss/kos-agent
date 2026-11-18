import { existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { SdkOneShot, sdkModelFor, type QueryFn, type SdkSpent } from "./sdkname.js";

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
  it("runs the model it is given with nothing to act with, in an empty folder outside the workspace, gone when the host closes", async () => {
    const run = fakeQuery(async function* () {
      yield result("Garden plan");
    });
    const shot = new SdkOneShot(run, { HOME: "/Users/o", USER: "o" });
    const spent: SdkSpent[] = [];
    const answer = await shot.ask({ ...ask(), spent: (s) => void spent.push(s) });
    const used = { model: MODEL, inputTokens: 120, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.00015 };
    expect(answer).toEqual({ text: "Garden plan", provider: "anthropic", models: [used] });
    expect(spent).toEqual([{ provider: "anthropic", models: [used] }]);
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
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
    });
    expect(await options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1" } as never)).toMatchObject({ behavior: "deny" });
    // Its own folder, empty, under the temp folder; the same one for the next ask, and gone on close.
    const dir = options.cwd!;
    expect(basename(dir)).toMatch(/^kos-ask-/);
    expect(dir.startsWith(realpathSync(tmpdir())) || dir.startsWith(tmpdir())).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    await shot.ask(ask());
    expect(run.started[1]!.options.cwd).toBe(dir);
    shot.close();
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses at once past two at a time, so the namer uses the opening words", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const run = fakeQuery(async function* () {
      await held;
      yield result("Garden plan");
    });
    const shot = new SdkOneShot(run, { HOME: "/h" });
    const first = shot.ask(ask());
    const second = shot.ask(ask());
    await expect(shot.ask(ask())).rejects.toThrow(/busy/);
    expect(run.started).toHaveLength(2);
    release();
    await Promise.all([first, second]);
    await expect(shot.ask(ask())).resolves.toMatchObject({ text: "Garden plan" });
    shot.close();
  });

  it("gives up when the deadline passes, stops the process, and still logs what it spent", async () => {
    let stopped = false;
    const run = fakeQuery(async function* (options) {
      yield { type: "assistant", message: { model: MODEL, usage: { input_tokens: 90, output_tokens: 2 } } } as unknown as SDKMessage;
      await new Promise((r) => options.abortController!.signal.addEventListener("abort", r));
      stopped = true;
    });
    const shot = new SdkOneShot(run, { HOME: "/h" });
    const spent: SdkSpent[] = [];
    await expect(shot.ask({ ...ask(AbortSignal.timeout(20)), spent: (s) => void spent.push(s) })).rejects.toThrow(/timed out/);
    expect(stopped).toBe(true);
    expect(spent).toEqual([{ provider: "anthropic", models: [{ model: MODEL, inputTokens: 90, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 }] }]);
    shot.close();
  });

  it("fails on a query that ends without an answer", async () => {
    const error = new SdkOneShot(
      fakeQuery(async function* () {
        yield { type: "result", subtype: "error_max_turns" } as unknown as SDKMessage;
      }),
      { HOME: "/h" },
    );
    await expect(error.ask(ask())).rejects.toThrow(/error_max_turns/);
    error.close();
    const none = new SdkOneShot(
      fakeQuery(async function* () {
        yield* [];
      }),
      { HOME: "/h" },
    );
    await expect(none.ask(ask())).rejects.toThrow(/no result/);
    none.close();
  });
});
