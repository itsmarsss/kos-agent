import type { Route, Task } from "../models/router.js";
import { toolUse } from "../kernel/caller.js";
import type {
  ContentBlock,
  GenerateDelta,
  GenerateRequest,
  ModelMessage,
  ModelResponse,
  StopReason,
  ToolDef,
} from "../models/types.js";
import { textOf, toolUsesOf } from "../models/types.js";
import { keepRecentPictures } from "./pictures.js";
import { isScreenTool } from "./screen.js";
import type { ToolExecution } from "./registry.js";

/** Anything that can run inference for a task (the ModelRouter satisfies this). */
export interface Inference {
  generate(task: Task, req: GenerateRequest): Promise<ModelResponse>;
  /** What answers a task, where the inference can say. */
  routeFor?(task: Task): Route;
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
  /**
   * The step after a call to a screen tool goes to the screen route: once the
   * turn has chosen to work on a screen, the looking and clicking runs on the
   * quicker model, and the turn's own model takes over again at the first
   * step that is not on a screen.
   */
  screen?: boolean;
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
  /** The last step called a screen tool, so this one is a screen step. */
  let onScreen = false;

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
    /** What this call has said so far, kept if the turn is stopped before it is done. */
    let streamed = "";
    const onDelta = options.onDelta;
    let response;
    try {
      response = await inference.generate(options.screen && onScreen ? "screen" : task, {
        system: options.system,
        messages: keepRecentPictures(messages),
        ...(tools.length ? { tools } : {}),
        ...(onDelta
          ? {
              onDelta: (delta: GenerateDelta) => {
                if (delta.kind === "text") streamed += delta.text;
                onDelta(delta);
              },
            }
          : {}),
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
        // The half an answer the owner already watched arrive stays said.
        if (streamed.trim()) messages.push({ role: "assistant", content: [{ type: "text", text: streamed }] });
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
    onScreen = running.every((call) => isScreenTool(call.name));
    const deferred = options.parallelToolCalls ? [] : toolUses.slice(1);

    const results: ContentBlock[] = [];
    for (const call of running) {
      // Run under the call's own id, so whatever is kept about this step
      // (a picture of the browser after it) can find its card later.
      const { content, isError, images } = await toolUse.run(call.id, () => tools_.execute(call.name, call.input));
      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content,
        isError,
        ...(images?.length ? { images } : {}),
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
