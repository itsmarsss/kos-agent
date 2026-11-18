import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ONLY_OWN_MCP, credentials } from "../builds/runner.js";
import type { Route } from "../models/router.js";
import type { SdkModelUsage } from "./sdkchat.js";

/**
 * One short answer from the Agent SDK engine, for a chore the cheap route
 * would do if it could be asked: naming a chat on a subscription with no key.
 *
 * Each call starts a Claude Code process of its own (a native binary of about
 * 200 MB, its first start of a session a few seconds), so this is for things
 * asked once per chat, never per turn. Nothing it could act with is there: no
 * built-in tool, no MCP server, no settings of the owner's, one model turn,
 * and no session written to disk.
 */

/** The provider whose models the engine runs. */
const SDK_PROVIDER = "anthropic";
/** The engine's own name for its smallest model, used when the owner's cheap model is another provider's. */
const SDK_SMALLEST = "haiku";

/**
 * Which model a one-shot ask runs on: the owner's cheap model when the engine
 * can run it, else the engine's smallest.
 */
export function sdkModelFor(cheap: Route | undefined): string {
  return cheap?.provider === SDK_PROVIDER ? cheap.spec.model : SDK_SMALLEST;
}

export interface SdkAsk {
  system: string;
  text: string;
  signal: AbortSignal;
  model: string;
}

/** The answer, and what it cost by model, as the spend log keeps it. */
export interface SdkAnswer {
  text: string;
  models: SdkModelUsage[];
}

/** The SDK's query, so a test can stand in for the process. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** What a one-shot ask is run with: no tools, no turns past one, nothing kept. */
export function oneShotOptions(ask: Pick<SdkAsk, "system" | "model">, cwd: string, abortController: AbortController, source: NodeJS.ProcessEnv = process.env): Options {
  const { env, home } = credentials(cwd, source);
  return {
    abortController,
    cwd,
    additionalDirectories: [],
    model: ask.model,
    systemPrompt: ask.system,
    tools: [],
    allowedTools: [],
    // Anything asked for anyway is refused, not put to the owner.
    canUseTool: async () => ({ behavior: "deny", message: "no tools here" }),
    mcpServers: {},
    ...ONLY_OWN_MCP,
    settingSources: [],
    maxTurns: 1,
    persistSession: false,
    env: { ...env, HOME: home, ENABLE_TOOL_SEARCH: "false" },
  };
}

function usageOf(message: Extract<SDKMessage, { type: "result" }>): SdkModelUsage[] {
  return Object.entries(message.modelUsage ?? {}).map(([model, u]) => ({
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
    costUSD: u.costUSD,
  }));
}

/**
 * Ask once and give the answer. Throws when the process fails, the query
 * ends without a result, or the signal fires first.
 */
export async function askSdkOnce(ask: SdkAsk, cwd: string, run: QueryFn = query, source: NodeJS.ProcessEnv = process.env): Promise<SdkAnswer> {
  const ac = new AbortController();
  const abort = (): void => ac.abort();
  if (ask.signal.aborted) throw new Error("timed out before the query started");
  ask.signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const message of run({ prompt: ask.text, options: oneShotOptions(ask, cwd, ac, source) })) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success") throw new Error(`the query ended with ${message.subtype}`);
      return { text: message.result, models: usageOf(message) };
    }
    throw new Error(ask.signal.aborted ? "timed out" : "the query gave no result");
  } catch (err) {
    if (ask.signal.aborted) throw new Error("timed out");
    throw err;
  } finally {
    ask.signal.removeEventListener("abort", abort);
    ac.abort();
  }
}
