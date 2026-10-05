import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ToolBox } from "../agent/loop.js";
import { credentials } from "../builds/runner.js";
import { toZodShape } from "./schema.js";

/**
 * A chat turn run by the Claude Agent SDK instead of the model API.
 *
 * The reason is money: builds already run on a Claude Code subscription, and
 * a chat turn is the same kind of work. This lets the owner spend the
 * subscription they already have rather than API credits.
 *
 * What must not change is containment. Claude Code brings its own Read,
 * Write, Edit and Bash, and none of them know about the workspace jail or
 * the risk tiers. So they are disallowed outright and KOS's own tools are
 * handed over as an in-process MCP server: the only way this turn can touch
 * anything is through the same guarded path a normal turn uses, with the same
 * approvals. If that list were ever to leak a built-in through, the jail
 * would be gone -- which is why the allow list is built by name from the
 * registry rather than left open.
 */

/** Claude Code's own tools. None of them go through KOS's gate. */
const BUILTINS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "KillShell",
  "BashOutput",
];

/** The MCP name the SDK exposes KOS's tools under. */
const SERVER = "kos";

/** One call the agent made, in the shape the transcript stores. */
export interface SdkToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export interface SdkChatResult {
  text: string;
  /**
   * What it did on the way, so the transcript can hold it.
   *
   * The tools run inside the MCP bridge rather than through KOS's own loop,
   * so nothing was written down: the calls streamed live and then vanished
   * the moment the turn ended and the transcript reloaded.
   */
  calls: SdkToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /**
   * What each model actually did, as the SDK accounts for it.
   *
   * Summing the per-message usage counted the main loop only, and only the
   * uncached tokens: a turn that read 40k from the cache reported a few
   * hundred. The SDK's own totals cover subagents and sidechains too, name
   * the real model rather than "the SDK", and price it.
   */
  models: SdkModelUsage[];
  /** The SDK's own estimate for the whole call, in USD. */
  costUSD: number;
  /** True when the SDK stopped for its own reasons rather than answering. */
  stopped: boolean;
}

export interface SdkModelUsage {
  /** The canonical model id, so spend is attributed to what actually ran. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

export interface SdkChatOptions {
  prompt: string;
  /**
   * Pictures and files that came with the message.
   *
   * Sent as content blocks rather than folded into the prompt, because a
   * prompt is a string and a picture is not. Without this the SDK path saw
   * only text: an owner who attached a photo got an answer written as though
   * nothing had been attached.
   */
  attachments?: { mediaType: string; data: string }[];
  system: string;
  tools: ToolBox;
  cwd: string;
  model?: string;
  maxTurns?: number;
  /** Streamed reasoning and text, for the live view. */
  onDelta?: (delta: { kind: "reasoning" | "text"; text: string }) => void;
  env?: NodeJS.ProcessEnv;
  /** Aborts the SDK query when the owner presses Stop. */
  signal?: AbortSignal;
}

/**
 * The conversation so far, in front of what was just said.
 *
 * The SDK keeps its own session, but KOS's transcript is the one the owner
 * edits, compacts and rewinds, so that is the one that must be authoritative.
 * Rendering it into the prompt each turn keeps a single source of truth at
 * the cost of re-sending it -- which on a subscription is the cheaper of the
 * two mistakes.
 */
export function priorForSdk(
  history: { role: string; content: unknown }[],
  text: string,
): string {
  const spoken = history
    .map((m) => {
      const blocks = Array.isArray(m.content) ? m.content : [];
      /*
       * Text, plus a note where something was not text.
       *
       * Dropping non-text blocks silently made an earlier picture look like
       * it had never been sent, so a follow-up question about it read as the
       * owner asking about nothing.
       */
      const said = blocks
        .map((b) => {
          const block = b as { type?: string; text?: unknown; name?: unknown };
          if (block.type === "text" && typeof block.text === "string") {
            return block.text;
          }
          if (block.type === "image") {
            return `[a picture${typeof block.name === "string" ? `: ${block.name}` : ""}]`;
          }
          if (block.type === "file" && typeof block.text === "string") {
            return `[${typeof block.name === "string" ? block.name : "a file"}]\n${block.text}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!said) return "";
      return `${m.role === "user" ? "Owner" : "You"}: ${said}`;
    })
    .filter(Boolean);

  if (spoken.length === 0) return text;
  return [
    "The conversation so far, oldest first:",
    "<<<history",
    ...spoken,
    "history>>>",
    "",
    "The owner now says:",
    text,
  ].join("\n");
}

/** Strip the MCP prefix the SDK adds, so callers see KOS's own tool names. */
export function plainName(name: string): string {
  const prefix = `mcp__${SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The SDK's name for one of KOS's tools. */
export function sdkName(name: string): string {
  return `mcp__${SERVER}__${name.replace(/\./g, "_")}`;
}

/**
 * Wrap the guarded toolbox as an in-process MCP server.
 *
 * Names are flattened because MCP tool names may not contain dots, and
 * mapped back before execution so the registry still sees files.read.
 */
function serverFor(tools: ToolBox, record: (call: SdkToolCall) => void) {
  let n = 0;
  const defined = tools.defs().map((spec) =>
    tool(
      spec.name.replace(/\./g, "_"),
      spec.description,
      toZodShape(spec.inputSchema),
      async (args: Record<string, unknown>) => {
        const result = await tools.execute(spec.name, args ?? {});
        record({
          id: `sdk-${++n}`,
          name: spec.name,
          input: args ?? {},
          result: result.content,
          isError: result.isError === true,
        });
        return {
          content: [{ type: "text" as const, text: result.content }],
          ...(result.isError ? { isError: true } : {}),
        };
      },
    ),
  );
  return { server: createSdkMcpServer({ name: SERVER, tools: defined }), defined };
}

export async function runSdkChat(
  options: SdkChatOptions,
): Promise<SdkChatResult> {
  const calls: SdkToolCall[] = [];
  const { server } = serverFor(options.tools, (call) => calls.push(call));
  const allowed = options.tools.defs().map((d) => sdkName(d.name));
  const { env, home } = credentials(options.cwd, options.env ?? process.env);

  let text = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  const models: SdkModelUsage[] = [];
  let costUSD = 0;
  let stopped = false;

  /*
   * A string prompt cannot carry a picture, so a turn with one is sent as a
   * message instead. One message either way; the shape differs because the
   * content does.
   */
  const images = (options.attachments ?? []).filter((a) =>
    a.mediaType.startsWith("image/"),
  );
  const prompt = images.length
    ? (async function* () {
        yield {
          type: "user" as const,
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content: [
              { type: "text" as const, text: options.prompt },
              ...images.map((a) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: a.mediaType as "image/png",
                  data: a.data,
                },
              })),
            ],
          },
        };
      })()
    : options.prompt;

  // The SDK cancels a query through an AbortController, so bridge the caller's
  // signal (from kernel.stop()) to one. An already-aborted signal aborts it at
  // once, so a stop requested before the query starts still takes.
  const ac = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) ac.abort();
    else options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const stream = query({
    prompt,
    options: {
      abortController: ac,
      cwd: options.cwd,
      additionalDirectories: [],
      permissionMode: "default",
      // No user, project or local settings: the same isolation a build gets,
      // for the same reason. A permissions.allow rule written months ago must
      // not widen what a chat turn can do.
      settingSources: [],
      // Only KOS's tools exist. The built-ins are named individually as well
      // as excluded by the allow list, because an allow list that grows a
      // hole is a jail that quietly opens.
      allowedTools: allowed,
      disallowedTools: BUILTINS,
      mcpServers: { [SERVER]: server },
      maxTurns: options.maxTurns ?? 24,
      includePartialMessages: true,
      ...(options.model ? { model: options.model } : {}),
      env: { ...env, HOME: home },
      systemPrompt: { type: "preset", preset: "claude_code", append: options.system },
    },
  });

  try {
  for await (const message of stream as AsyncIterable<SDKMessage>) {
    const m = message as unknown as Record<string, unknown>;

    if (m["type"] === "stream_event") {
      const event = m["event"] as { delta?: { type?: string; text?: string; thinking?: string } };
      const delta = event?.delta;
      if (delta?.text) options.onDelta?.({ kind: "text", text: delta.text });
      if (delta?.thinking) {
        options.onDelta?.({ kind: "reasoning", text: delta.thinking });
      }
      continue;
    }

    if (m["type"] === "assistant") {
      const content = (m["message"] as { content?: unknown[] })?.content ?? [];
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && b.text) text += b.text;
      }
      continue;
    }

    if (m["type"] === "result") {
      // A result with no text of its own is the SDK stopping rather than
      // answering: an error, or the turn limit.
      if (m["subtype"] !== "success") stopped = true;
      if (typeof m["result"] === "string" && !text) text = m["result"];
      /*
       * Accounting comes from here, not from adding up the assistant
       * messages. The result carries a running total for every model the
       * call used, and it is cumulative, so this is read rather than summed.
       */
      const perModel = m["modelUsage"] as
        | Record<string, Record<string, number | string>>
        | undefined;
      for (const [name, raw] of Object.entries(perModel ?? {})) {
        const canonical =
          typeof raw["canonicalModel"] === "string" ? raw["canonicalModel"] : name;
        models.push({
          model: canonical,
          inputTokens: Number(raw["inputTokens"] ?? 0),
          outputTokens: Number(raw["outputTokens"] ?? 0),
          cacheReadInputTokens: Number(raw["cacheReadInputTokens"] ?? 0),
          cacheCreationInputTokens: Number(raw["cacheCreationInputTokens"] ?? 0),
          costUSD: Number(raw["costUSD"] ?? 0),
        });
      }
      costUSD = Number(m["total_cost_usd"] ?? 0);
      break;
    }
  }
  } catch (err) {
    // Aborting the SDK query rejects the stream; that is the owner pressing
    // Stop, a clean stop rather than a failure. Anything else still throws.
    if (ac.signal.aborted) stopped = true;
    else throw err;
  }

  /*
   * The headline pair, for callers that want one number.
   *
   * Cache reads and cache writes are input the model was given, so they are
   * counted as input. Leaving them out was most of why the old total read so
   * low on a long conversation, where nearly all the input is cached.
   */
  for (const m of models) {
    usage.inputTokens +=
      m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
    usage.outputTokens += m.outputTokens;
  }

  return { text: text.trim(), calls, usage, models, costUSD, stopped };
}
