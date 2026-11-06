import { randomUUID } from "node:crypto";

import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ToolBox } from "../agent/loop.js";
import { SCREEN_HANDOFF, SCREEN_PROMPT, forScreenAgent, isScreenTool } from "../agent/screen.js";
import { fenced, isShelved } from "../context/shelf.js";
import { splitOwnerWords } from "../kernel/transcript.js";
import type { Effort } from "../models/provider.js";
import { toolUse } from "../kernel/caller.js";
import { STOPPED_RESULT } from "../kernel/guarded.js";
import { ONLY_OWN_MCP, credentials } from "../builds/runner.js";
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
  /** True when the turn ended short of an answer: the owner's stop, an error, or the turn limit. */
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
  /**
   * After this many pictures in one query, the turn carries on in a fresh one.
   * Every picture a query has taken is sent again with each of its later
   * steps, and a step slowed from five seconds to seventeen over ten real
   * screens; a fresh query starts from the task, the steps so far and the
   * screen as it is now. Unset, one query runs the whole turn.
   */
  picturesPerQuery?: number;
  /** Told as the turn carries on in a fresh query, before it starts. */
  onFreshQuery?: () => void;
  /**
   * The model the screen steps run on, as a subagent the turn hands them to.
   * Unset, the turn does its screen work itself, as before.
   */
  screen?: { model: string; effort?: Effort };
}

/**
 * Where a turn had got to, for the fresh query that carries it on: what was
 * asked, and every step so far with what it answered, newest last. The screen
 * as it is now rides with it as a picture.
 */
export function carryOn(prompt: string, calls: SdkToolCall[]): string {
  const steps = calls.map((c, i) => {
    // The owner's words that rode in on a result are theirs, kept whole and outside the result's fence.
    const { content, said } = splitOwnerWords(c.result);
    // A screen step's answer is a line about what it did, and the screen is attached; any other result is kept whole (or its stub), since what it said may be what the rest of the turn needs.
    const answer = isScreenTool(c.name) ? content.replace(/\s+/g, " ").slice(0, 300) : content;
    const owner = said.map((w) => `\n   The owner said, while you worked: ${w}`).join("");
    return `${i + 1}. ${c.name} ${JSON.stringify(c.input).slice(0, 300)}\n${fenced(c.name, answer)}${owner}`;
  });
  return `${prompt}\n\n[You are partway through this turn. These steps are already done, newest last; the screen as it is now is attached. Carry on from here: do not repeat them or start over, and keep any session that is open.]\n${steps.join("\n")}`;
}

/** Lets a screen tool through for the screen agent, and only for it. */
function screenGate(screenTools: string[]): CanUseTool {
  return async (name, input, { agentID }) => {
    if (screenTools.includes(name) && agentID) return { behavior: "allow", updatedInput: input };
    if (screenTools.includes(name)) return { behavior: "deny", message: `Screen tools run in the screen agent: hand this to it with the Task tool, subagent_type "${SCREEN_AGENT}".` };
    return { behavior: "deny", message: `${name} is not one of this chat's tools.` };
  };
}

/** The subagent the turn hands screen work to, and the tool it is handed over with. */
const SCREEN_AGENT = "screen";
const HANDOFF_TOOLS = ["Task", "Agent"];

/**
 * How the turn's tools divide when screen work is handed on: the screen tools
 * go to the subagent alone, so their pictures stay in its context and are gone
 * when it reports back, and the turn keeps the rest and the means to hand on.
 */
export function screenSplit(names: string[], screen: SdkChatOptions["screen"]): {
  main: string[];
  agent?: { tools: string[]; model: string; effort?: Effort };
} {
  if (!screen || !names.some(isScreenTool)) return { main: names.map(sdkName) };
  return {
    main: [...names.filter((n) => !isScreenTool(n)).map(sdkName), ...HANDOFF_TOOLS],
    agent: { tools: names.filter(forScreenAgent).map(sdkName), model: screen.model, ...(screen.effort ? { effort: screen.effort } : {}) },
  };
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
  /** Big results carried in words, whole or as stubs: only when setting them aside is on. */
  opts: { kept?: boolean } = {},
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
          // A big result is carried in words, whole while it is recent and as its stub after, so a follow-up need not read it again.
          const result = b as { type?: string; content?: unknown };
          if (opts.kept && result.type === "tool_result" && typeof result.content === "string" && isShelved(result.content)) {
            return fenced("result", result.content);
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!said) return "";
      const fromTool = blocks.length > 0 && blocks.every((b) => (b as { type?: string }).type === "tool_result");
      return `${fromTool ? "A tool you called" : m.role === "user" ? "Owner" : "You"}: ${said}`;
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
/**
 * Glue two spoken pieces so a sentence end never runs into the next start.
 *
 * The SDK answers across several assistant messages, one per step around a
 * tool call, and they were concatenated with nothing between them: "Flagging
 * that first." and "Plan file exists" became "first.Plan file exists". A
 * single space is added only when neither side already has whitespace, so a
 * sentence split mid-word keeps its own spacing and a boundary gets one.
 */
export function joinSaid(before: string, piece: string): string {
  if (!before) return piece;
  if (!piece) return before;
  if (/\s$/.test(before) || /^\s/.test(piece)) return before + piece;
  return `${before} ${piece}`;
}

export function sdkName(name: string): string {
  return `mcp__${SERVER}__${name.replace(/\./g, "_")}`;
}

/**
 * Wrap the guarded toolbox as an in-process MCP server.
 *
 * Names are flattened because MCP tool names may not contain dots, and
 * mapped back before execution so the registry still sees files.read.
 */
function serverFor(tools: ToolBox, record: (call: SdkToolCall, images: { data: string; mediaType: string }[]) => void) {
  // An id per call, unique across turns: it is the call's id in the stored
  // history, and what keeps the picture a step took with that step's card.
  const turn = randomUUID().slice(0, 8);
  let n = 0;
  /** Calls started and not yet answered, so a stopped turn still holds them. */
  const running = new Map<string, Pick<SdkToolCall, "name" | "input">>();
  const defined = tools.defs().map((spec) =>
    tool(
      spec.name.replace(/\./g, "_"),
      spec.description,
      toZodShape(spec.inputSchema),
      async (args: Record<string, unknown>) => {
        const id = `sdk-${turn}-${++n}`;
        running.set(id, { name: spec.name, input: args ?? {} });
        const result = await toolUse.run(id, () => tools.execute(spec.name, args ?? {})).catch((err: unknown) => {
          running.delete(id);
          throw err;
        });
        // Recorded and let go in one step, so a stop never finds it in neither.
        running.delete(id);
        record({
          id,
          name: spec.name,
          input: args ?? {},
          result: result.content,
          isError: result.isError === true,
        }, result.images ?? []);
        return {
          content: [
            { type: "text" as const, text: result.content },
            ...(result.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType })),
          ],
          ...(result.isError ? { isError: true } : {}),
        };
      },
    ),
  );
  return { server: createSdkMcpServer({ name: SERVER, tools: defined }), defined, running };
}

/**
 * A query's messages until the stop, and not one moment after it.
 *
 * Aborting a query does not end its stream at once: the SDK gives the Claude
 * Code process two seconds to exit before it is killed, and only then does
 * the stream end. A stopped turn read the whole of that grace. Here the
 * stream is left as soon as the stop lands; it settles on its own behind.
 */
export async function* untilStopped<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  if (!signal) {
    yield* source;
    return;
  }
  const stopped = new Promise<"stopped">((resolve) => {
    if (signal.aborted) resolve("stopped");
    else signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  });
  const messages = source[Symbol.asyncIterator]();
  let ended: "done" | "stopped" | undefined;
  try {
    for (;;) {
      const next = messages.next();
      // Left behind on a stop, where it rejects with the abort and nobody reads it.
      next.catch(() => undefined);
      const got = await Promise.race([next, stopped]);
      if (got === "stopped" || got.done) {
        ended = got === "stopped" ? "stopped" : "done";
        return;
      }
      yield got.value;
    }
  } finally {
    /*
     * Left early, the source is closed as for-await closes it: a query left
     * open keeps KOS's tool server connected to it, and the fresh query a
     * turn carries on in then has no tools. Waited for only until a stop,
     * which is the wait this is here to skip.
     */
    if (ended !== "done") {
      const closing = messages.return?.();
      closing?.catch(() => undefined);
      if (ended !== "stopped") await Promise.race([closing, stopped]);
    }
  }
}

/**
 * How long a stopped query is given to report what it spent. Interrupted, the
 * SDK answers with a result carrying the query's usage and cost; past this,
 * the turn ends on what it has seen, since Stop has to feel instant.
 */
const STOP_ACCOUNT_MS = 1_000;

/** A model message's usage as the stream reports it: the start's counts, then the end's output. */
interface SeenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function seenUsage(model: string, raw: Record<string, unknown> | undefined, before?: SeenUsage): SeenUsage {
  const n = (key: string, was = 0): number => (typeof raw?.[key] === "number" ? (raw[key] as number) : was);
  return {
    model,
    inputTokens: n("input_tokens", before?.inputTokens),
    outputTokens: n("output_tokens", before?.outputTokens),
    cacheReadInputTokens: n("cache_read_input_tokens", before?.cacheReadInputTokens),
    cacheCreationInputTokens: n("cache_creation_input_tokens", before?.cacheCreationInputTokens),
  };
}

export async function runSdkChat(
  options: SdkChatOptions,
): Promise<SdkChatResult> {
  const calls: SdkToolCall[] = [];
  /** The newest picture a tool answered with, and how many this query has taken. */
  let lastPicture: { data: string; mediaType: string } | undefined;
  let pictured = 0;
  const split = screenSplit(options.tools.defs().map((d) => d.name), options.screen);
  /*
   * A query ends for its pictures only when the screen work is the turn's
   * own: handed to a subagent, the pictures are the subagent's, and ending
   * the turn's query under it would lose the subagent's report.
   */
  const cap = split.agent ? undefined : options.picturesPerQuery;
  const { server, running } = serverFor(options.tools, (call, images) => {
    calls.push(call);
    // A screen's picture, not a plot python drew or one an MCP tool returned.
    if (images.length && isScreenTool(call.name)) {
      lastPicture = images.at(-1);
      pictured += 1;
    }
  });
  const allowed = split.main;
  const { env, home } = credentials(options.cwd, options.env ?? process.env);

  let text = "";
  /** What the reply in progress has said so far: kept if the turn is stopped before it is whole. */
  let streamed = "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  const models: SdkModelUsage[] = [];
  let costUSD = 0;
  let stopped = false;

  /*
   * Sent as a message, which can carry a picture and lets a full query be
   * interrupted with its accounts still reported.
   */
  const asMessage = (words: string, pictures: { mediaType: string; data: string }[]) =>
    (async function* () {
          yield {
            type: "user" as const,
            parent_tool_use_id: null,
            message: {
              role: "user" as const,
              content: [
                { type: "text" as const, text: words },
                ...pictures.map((a) => ({
                  type: "image" as const,
                  source: { type: "base64" as const, media_type: a.mediaType as "image/png", data: a.data },
                })),
              ],
            },
          };
    })();
  let prompt: AsyncIterable<SDKUserMessage> = asMessage(
    options.prompt,
    (options.attachments ?? []).filter((a) => a.mediaType.startsWith("image/")),
  );

  /** The turn's model round trips, across every query it runs in. */
  const budget = options.maxTurns ?? 24;
  let used = 0;
  for (;;) {
    // A stop that landed before this query, or between two, starts no new one.
    if (options.signal?.aborted) {
      stopped = true;
      break;
    }
    const ac = new AbortController();
    pictured = 0;
    /** This query has taken its share of pictures: it ends once the last one is back, and the turn goes on in a new one. */
    let full = false;

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
        // Nor the owner's claude.ai connectors: KOS's tools are the only ones.
        ...ONLY_OWN_MCP,
        // Only KOS's tools exist. The built-ins are named individually as well
        // as excluded by the allow list, because an allow list that grows a
        // hole is a jail that quietly opens.
        allowedTools: allowed,
        disallowedTools: split.agent ? BUILTINS.filter((b) => !HANDOFF_TOOLS.includes(b)) : BUILTINS,
        // The allow list is the session's, so the screen agent's own tools
        // cannot be on it without the turn having them too. They are let
        // through here instead, for the screen agent alone; the turn is told
        // to hand on. Anything else off the list is refused, as before.
        ...(split.agent ? { canUseTool: screenGate(split.agent.tools) } : {}),
        mcpServers: { [SERVER]: server },
        maxTurns: budget - used,
        includePartialMessages: true,
        ...(options.model ? { model: options.model } : {}),
        ...(split.agent
          ? {
              agents: {
                [SCREEN_AGENT]: {
                  description: "Does work on a screen or in a browser tab (a computer, the owner's Chrome, KOS's own browser) and reports what it did and saw.",
                  prompt: SCREEN_PROMPT,
                  tools: split.agent.tools,
                  model: split.agent.model,
                  ...(split.agent.effort ? { effort: split.agent.effort } : {}),
                  maxTurns: options.maxTurns ?? 24,
                },
              },
            }
          : {}),
        // Every tool is loaded up front: with tool search on, each turn spent a
        // model call finding KOS's own tools before it could use one.
        env: { ...env, HOME: home, ENABLE_TOOL_SEARCH: "false" },
        systemPrompt: { type: "preset", preset: "claude_code", append: split.agent ? `${options.system}\n\n${SCREEN_HANDOFF}` : options.system },
      },
    });
    /*
     * The caller's stop reaches the query: interrupted at once, so the model
     * stops, then read for at most a moment more, for the result that says
     * what the query spent, then left and aborted, so the Claude Code process
     * goes.
     */
    const leave = new AbortController();
    let grace: ReturnType<typeof setTimeout> | undefined;
    const onStop = (): void => {
      void stream.interrupt().catch(() => undefined);
      grace = setTimeout(() => leave.abort(), STOP_ACCOUNT_MS);
    };
    if (options.signal?.aborted) onStop();
    else options.signal?.addEventListener("abort", onStop, { once: true });
    /** Each model message's usage as it streams, by message id: what is known if no result comes. */
    const seen = new Map<string, SeenUsage>();
    let streaming: string | undefined;
    let accounted = false;

    try {
      for await (const message of untilStopped(stream as AsyncIterable<SDKMessage>, leave.signal)) {
        const m = message as unknown as Record<string, unknown>;

        // Usage as it streams, a subagent's included: the start's counts, the end's output, then the whole message's.
        if (m["type"] === "stream_event") {
          const event = m["event"] as { type?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
          if (event?.type === "message_start" && event.message?.id) {
            streaming = event.message.id;
            seen.set(streaming, seenUsage(event.message.model ?? "", event.message.usage));
          } else if (event?.type === "message_delta" && streaming && seen.has(streaming)) {
            seen.set(streaming, seenUsage(seen.get(streaming)!.model, event.usage, seen.get(streaming)));
          }
        }
        const said = m["type"] === "assistant" ? (m["message"] as { id?: string; model?: string; usage?: Record<string, unknown>; content?: unknown[] } | undefined) : undefined;
        if (said?.id) seen.set(said.id, seenUsage(said.model ?? "", said.usage, seen.get(said.id)));

        // Stopped: only the query's account is still wanted, and nothing more is said or shown.
        if (options.signal?.aborted && m["type"] !== "result") continue;

        // A subagent's frames carry the call that started it. Its words are its
        // report to the turn, not the turn's reply; its thinking still shows.
        const inSubagent = typeof m["parent_tool_use_id"] === "string";

        // A tool's answer, back with the model: the moment a full query can end
        // without losing the step it just took.
        if (!full && m["type"] === "user" && !inSubagent && cap && pictured >= cap) {
          full = true;
          void stream.interrupt().catch(() => undefined);
          continue;
        }

        if (m["type"] === "stream_event") {
          const event = m["event"] as { delta?: { type?: string; text?: string; thinking?: string } };
          const delta = event?.delta;
          if (delta?.text && !inSubagent) {
            streamed += delta.text;
            options.onDelta?.({ kind: "text", text: delta.text });
          }
          if (delta?.thinking) {
            options.onDelta?.({ kind: "reasoning", text: delta.thinking });
          }
          continue;
        }

        if (m["type"] === "assistant") {
          if (inSubagent) continue;
          streamed = "";
          const content = said?.content ?? [];
          for (const block of content) {
            const b = block as { type?: string; text?: string };
            if (b.type === "text" && b.text) text = joinSaid(text, b.text);
          }
          continue;
        }

        if (m["type"] === "result") {
          accounted = true;
          // A result with no text of its own is the SDK stopping rather than
          // answering: an error, or the turn limit.
          if (m["subtype"] !== "success" && !full) stopped = true;
          used += typeof m["num_turns"] === "number" ? m["num_turns"] : 1;
          if (typeof m["result"] === "string" && !text && !options.signal?.aborted) text = m["result"];
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
          costUSD += Number(m["total_cost_usd"] ?? 0);
          break;
        }
      }
    } catch (err) {
      // An interrupted or aborted query can reject its stream; that is the
      // owner pressing Stop, a clean stop rather than a failure. Anything
      // else still throws.
      if (!options.signal?.aborted && !ac.signal.aborted) throw err;
    } finally {
      options.signal?.removeEventListener("abort", onStop);
      clearTimeout(grace);
      if (options.signal?.aborted) ac.abort();
    }

    if (options.signal?.aborted) {
      stopped = true;
      // No result came in the moment allowed: what the stream showed is what is known, its cost not among it.
      if (!accounted) for (const u of seen.values()) if (u.model) models.push({ ...u, costUSD: 0 });
      // What was said, and what was under way: the half a reply the owner
      // watched arrive, and each call still running, as stopped.
      text = joinSaid(text, streamed);
      for (const [id, call] of running) calls.push({ id, ...call, result: STOPPED_RESULT, isError: true });
      break;
    }
    // The steps are the turn's, not each query's: a turn carried on in fresh queries stops where one query would have.
    if (!full || stopped) break;
    if (used >= budget) {
      stopped = true;
      break;
    }
    options.onFreshQuery?.();
    prompt = asMessage(carryOn(options.prompt, calls), lastPicture ? [lastPicture] : []);
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

  // A copy: a call stopped under the turn still records itself when it ends, after this has gone.
  return { text: text.trim(), calls: [...calls], usage, models, costUSD, stopped };
}
