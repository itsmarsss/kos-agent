import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ONLY_OWN_MCP, credentials } from "../builds/runner.js";
import type { Effort } from "../models/provider.js";
import type { Route } from "../models/router.js";
import type { TaskModelSetting } from "../models/settings.js";
import type { SdkModelUsage } from "./sdkchat.js";

/**
 * One short answer from the Agent SDK engine, for a chore the cheap route
 * would do if it could be asked: naming a chat on a subscription with no key.
 *
 * Each call starts a Claude Code process of its own (a native binary of about
 * 200 MB, its first start of a session a few seconds), so this is for things
 * asked once per chat, never per turn, and only a couple at a time. Nothing
 * it could act with is there: no built-in tool, no MCP server, no settings,
 * memory or CLAUDE.md of the owner's, one model turn, no session written to
 * disk, and a folder of its own that is empty, outside the workspace.
 */

/** The provider whose models the engine runs. */
export const SDK_PROVIDER = "anthropic";
/** The engine's own name for its smallest model, used when the owner's cheap model is another provider's. */
const SDK_SMALLEST = "haiku";
/** One-shots running at once, past which another is refused rather than queued: each is a process. */
export const MAX_IN_FLIGHT = 2;

/**
 * Which model a one-shot ask runs on: the owner's cheap model when the engine
 * can run it, else the engine's smallest.
 */
export function sdkModelFor(cheap: Route | undefined): string {
  return cheap?.provider === SDK_PROVIDER ? cheap.spec.model : SDK_SMALLEST;
}

/**
 * What a chat turn on the engine runs on: what the owner chose for the
 * reasoning route, when its provider is the engine's. Nothing chosen, or a
 * model the engine cannot run (another provider's), and the engine's own
 * defaults answer, as before: KOS's table is not pinned over them unasked.
 */
export function sdkTurnModel(reasoning: Route | undefined, chosen: TaskModelSetting | undefined): { model?: string; effort?: Effort } {
  if (!reasoning || reasoning.provider !== SDK_PROVIDER) return {};
  return {
    ...(chosen?.model ? { model: reasoning.spec.model } : {}),
    ...(chosen?.effort && reasoning.spec.effort ? { effort: reasoning.spec.effort } : {}),
  };
}

/** What an ask spent, by model, and with which provider: known from the result, or from the answer as it streamed. */
export interface SdkSpent {
  provider: string;
  models: SdkModelUsage[];
}

export interface SdkAsk {
  system: string;
  text: string;
  signal: AbortSignal;
  model: string;
  /** Told once what the ask spent, when anything is known of it, whether it answered or not. */
  spent?: (spent: SdkSpent) => void;
}

/** The answer, and what it cost by model, as the spend log keeps it. */
export interface SdkAnswer extends SdkSpent {
  text: string;
}

/** The SDK's query, so a test can stand in for the process. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** What a one-shot ask is run with: no tools, no turns past one, nothing kept, nothing of the owner's read. */
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
    env: { ...env, HOME: home, ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
  };
}

function resultUsage(message: Extract<SDKMessage, { type: "result" }>): SdkModelUsage[] {
  return Object.entries(message.modelUsage ?? {}).map(([model, u]) => ({
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
    costUSD: u.costUSD,
  }));
}

/** An answer's usage as it streamed, for an ask that ended before its result said what it cost. */
function streamedUsage(message: SDKMessage): SdkModelUsage | undefined {
  if (message.type !== "assistant") return undefined;
  const said = message.message as unknown as { model?: string; usage?: Record<string, unknown> };
  if (!said.model || !said.usage) return undefined;
  const n = (key: string): number => (typeof said.usage?.[key] === "number" ? (said.usage[key] as number) : 0);
  return {
    model: said.model,
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cacheReadInputTokens: n("cache_read_input_tokens"),
    cacheCreationInputTokens: n("cache_creation_input_tokens"),
    costUSD: 0,
  };
}

/**
 * The one-shots of a host: no more than a couple at once, each run in an
 * empty folder of the host's own, which goes when the host closes.
 */
export class SdkOneShot {
  private inFlight = 0;
  private dir: string | undefined;

  constructor(
    private readonly run: QueryFn = query,
    private readonly source: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Ask once. Throws at once when busy, and when the process fails, ends without a result, or the signal fires first. */
  async ask(ask: SdkAsk): Promise<SdkAnswer> {
    if (this.inFlight >= MAX_IN_FLIGHT) throw new Error("busy: other one-shots are running");
    if (ask.signal.aborted) throw new Error("timed out before the query started");
    this.inFlight += 1;
    const ac = new AbortController();
    const abort = (): void => ac.abort();
    ask.signal.addEventListener("abort", abort, { once: true });
    let models: SdkModelUsage[] = [];
    try {
      for await (const message of this.run({ prompt: ask.text, options: oneShotOptions(ask, this.folder(), ac, this.source) })) {
        const streamed = streamedUsage(message);
        if (streamed) models = [...models.filter((m) => m.model !== streamed.model), streamed];
        if (message.type !== "result") continue;
        models = resultUsage(message);
        if (message.subtype !== "success") throw new Error(`the query ended with ${message.subtype}`);
        return { text: message.result, provider: SDK_PROVIDER, models };
      }
      throw new Error(ask.signal.aborted ? "timed out" : "the query gave no result");
    } catch (err) {
      if (ask.signal.aborted) throw new Error("timed out");
      throw err;
    } finally {
      this.inFlight -= 1;
      ask.signal.removeEventListener("abort", abort);
      ac.abort();
      if (models.length) ask.spent?.({ provider: SDK_PROVIDER, models });
    }
  }

  /** The empty folder the process runs in and keeps its account files in, made the first time it is needed. */
  private folder(): string {
    this.dir ??= mkdtempSync(join(tmpdir(), "kos-ask-"));
    return this.dir;
  }

  close(): void {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    this.dir = undefined;
  }
}
