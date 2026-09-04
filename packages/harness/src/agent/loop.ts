import type { Task } from "../models/router.js";
import type {
  ContentBlock,
  GenerateRequest,
  ModelMessage,
  ModelResponse,
  StopReason,
  ToolDef,
} from "../models/types.js";
import { textOf, toolUsesOf } from "../models/types.js";
import type { ToolExecution } from "./registry.js";

/** Anything that can run inference for a task (the ModelRouter satisfies this). */
export interface Inference {
  generate(task: Task, req: GenerateRequest): Promise<ModelResponse>;
}

/**
 * What the loop needs from a tool source: the defs to offer the model and an
 * execute path. ToolRegistry satisfies this directly; the kernel passes a
 * guarded wrapper (secret injection + audit + approval gate) that also does.
 */
export interface ToolBox {
  defs(): ToolDef[];
  execute(name: string, input: Record<string, unknown>): Promise<ToolExecution>;
}

export interface AgentOptions {
  system?: string;
  task?: Task;
  /** Hard cap on model round-trips, preventing runaway tool loops. */
  maxIterations?: number;
  /**
   * Run every call the model emitted in one go. Off by default: a batch is a
   * plan fired before any of it comes back, so a wrong first assumption is
   * carried through all of it.
   */
  parallelToolCalls?: boolean;
  /** Forwarded to the provider, so a reader can watch the turn as it runs. */
  onDelta?: GenerateRequest["onDelta"];
  /**
   * Asked before each round trip. Returning true ends the turn where it is,
   * with whatever has been said so far, so the owner can stop a run that has
   * clearly gone wrong instead of waiting it out.
   */
  shouldStop?: () => boolean;
  /** Dropped mid-call when the owner asks the turn to stop. */
  signal?: AbortSignal;
}

export interface AgentResult {
  /** Full conversation, including the final assistant turn. */
  messages: ModelMessage[];
  /** Concatenated text of the final assistant turn. */
  finalText: string;
  /** True when the owner asked it to stop rather than it finishing. */
  stopped?: boolean;
  /** Number of model round-trips taken. */
  iterations: number;
  stopReason: StopReason;
  /** True if the loop stopped because it hit maxIterations with tools pending. */
  exhausted: boolean;
}

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * The core agent loop: call the model, run any tool calls, feed the results
 * back, and repeat until the model stops calling tools or the iteration cap is
 * hit. This is the minimal tool-call cycle every channel and cron self_prompt
 * drives.
 */
export async function runAgent(
  inference: Inference,
  tools_: ToolBox,
  input: string | ModelMessage[],
  options: AgentOptions = {},
): Promise<AgentResult> {
  const task = options.task ?? "reasoning";
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tools = tools_.defs();

  const messages: ModelMessage[] =
    typeof input === "string"
      ? [{ role: "user", content: [{ type: "text", text: input }] }]
      : [...input];

  /*
   * Where this turn's own messages begin.
   *
   * The history in front of the model includes every earlier answer, so
   * looking for "the last assistant message" found the previous turn's reply
   * when this one had not produced any. A turn stopped before it said
   * anything then answered with whatever it had said last time.
   */
  const before = messages.length;
  const saidThisTurn = (): string =>
    textOf(
      [...messages.slice(before)].reverse().find((m) => m.role === "assistant")
        ?.content ?? [],
    );

  let iterations = 0;
  let stopReason: StopReason = "end_turn";

  while (iterations < maxIterations) {
    if (options.shouldStop?.()) {
      return {
        messages,
        finalText: saidThisTurn(),
        iterations,
        stopReason,
        exhausted: false,
        stopped: true,
      };
    }
    iterations += 1;
    let response;
    try {
      response = await inference.generate(task, {
        system: options.system,
        messages,
        ...(tools.length ? { tools } : {}),
        ...(options.onDelta ? { onDelta: options.onDelta } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      /*
       * A dropped call is a stop, not a failure.
       *
       * Asking to stop aborts the request the turn is waiting on, and the
       * provider raises. Reporting that as an error would tell the owner
       * their turn broke when what happened is the thing they asked for.
       */
      if (options.shouldStop?.()) {
        return {
          messages,
          finalText: saidThisTurn(),
          iterations,
          stopReason,
          exhausted: false,
          stopped: true,
        };
      }
      throw err;
    }
    stopReason = response.stopReason;
    messages.push({ role: "assistant", content: response.content });

    const toolUses = toolUsesOf(response.content);
    if (toolUses.length === 0) {
      return {
        messages,
        finalText: textOf(response.content),
        iterations,
        stopReason,
        exhausted: false,
      };
    }

    // One call, then look at what came back.
    //
    // Asking the provider for this is only a strong hint: with it set, batches
    // of six became mostly one, but twos still came through. Enforced here it
    // is a guarantee. The calls that do not run still get a result, because
    // both providers require one for every call they made, and that result
    // tells the model to ask again if it still wants them.
    const running = options.parallelToolCalls ? toolUses : toolUses.slice(0, 1);
    const deferred = options.parallelToolCalls ? [] : toolUses.slice(1);

    const results: ContentBlock[] = [];
    for (const call of running) {
      const { content, isError } = await tools_.execute(call.name, call.input);
      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content,
        isError,
      });
    }
    for (const call of deferred) {
      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content:
          "not run: this conversation takes one tool call at a time, so you can read each result before choosing the next. Call it again if you still need it.",
        isError: false,
      });
    }
    messages.push({ role: "user", content: results });
  }

  // Hit the iteration cap with tool calls still pending.
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  return {
    messages,
    finalText: lastAssistant ? textOf(lastAssistant.content) : "",
    iterations,
    stopReason,
    exhausted: true,
  };
}
