import OpenAI from "openai";

import type { Effort, ModelSpec, Provider } from "../provider.js";
import type {
  ContentBlock,
  GenerateRequest,
  ModelMessage,
  ModelResponse,
  StopReason,
} from "../types.js";

const DEFAULT_MAX_TOKENS = 16000;

/**
 * OpenAI over the Responses API.
 *
 * Chat Completions cannot carry a reasoning effort alongside function tools
 * for the gpt-5 line, and the gpt-5.6 models refuse function tools there
 * outright. KOS always sends tools, so on Chat Completions the effort in a
 * ModelSpec was silently unusable and the newest models were unreachable.
 */

type ResponseParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

/**
 * OpenAI function names must match ^[a-zA-Z0-9_-]+$. KOS tools use dotted
 * names (files.read). Encode dots for the wire; decode on the way back.
 */
export function toOpenAIToolName(name: string): string {
  return name.replace(/\./g, "__");
}

export function fromOpenAIToolName(name: string): string {
  return name.replace(/__/g, ".");
}

function textOf(content: ModelMessage["content"]): string {
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      // A model can only read a file as text; the name goes with it so it
      // knows what it is looking at.
      if (b.type === "file") return `Attached file ${b.name}:\n\n${b.text}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Map one internal message to Responses input items.
 *
 * A tool call and its result are separate top-level items here rather than
 * fields on a message, and both carry the same call_id. Dropping either one
 * leaves the model with a call it never saw answered.
 */
function toInputItems(message: ModelMessage): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  const text = textOf(message.content);

  if (message.role === "assistant") {
    // Plain string content: the structured output_text form is an output
    // item, which carries an id and status we do not have when replaying.
    // A reasoning block is for the reader and is deliberately not echoed:
    // the provider owns its own reasoning state.
    if (text) out.push({ role: "assistant", content: text });
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const call = block as { id: string; name: string; input: unknown };
      out.push({
        type: "function_call",
        call_id: call.id,
        name: toOpenAIToolName(call.name),
        arguments: JSON.stringify(call.input),
      });
    }
    return out;
  }

  const results = message.content.filter((b) => b.type === "tool_result");
  for (const block of results) {
    const result = block as { toolUseId: string; content: string };
    out.push({
      type: "function_call_output",
      call_id: result.toolUseId,
      output: result.content,
    });
  }
  if (results.length === 0) {
    const images = message.content.filter((b) => b.type === "image");
    if (images.length === 0) {
      out.push({ role: "user", content: text });
    } else {
      out.push({
        role: "user",
        content: [
          ...(text ? [{ type: "input_text" as const, text }] : []),
          ...images.map((b) => {
            const img = b as { mediaType: string; data: string };
            return {
              type: "input_image" as const,
              image_url: `data:${img.mediaType};base64,${img.data}`,
              detail: "auto" as const,
            };
          }),
        ],
      });
    }
  }
  return out;
}

export function toResponsesInput(messages: ModelMessage[]): ResponseInputItem[] {
  return messages.flatMap(toInputItems);
}

export function toResponsesTools(
  tools: NonNullable<GenerateRequest["tools"]>,
): ResponseParams["tools"] {
  return tools.map((t) => ({
    type: "function" as const,
    name: toOpenAIToolName(t.name),
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    strict: false,
  }));
}

/**
 * KOS efforts are a superset of what OpenAI accepts, so the two above its top
 * setting land on "high" rather than being dropped or rejected.
 */
export function toReasoningEffort(
  effort: Effort,
): "low" | "medium" | "high" {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

export function buildResponsesParams(
  req: GenerateRequest,
  spec: ModelSpec,
): ResponseParams {
  const params: ResponseParams = {
    model: spec.model,
    input: toResponsesInput(req.messages),
    max_output_tokens: spec.maxTokens ?? req.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Nothing here needs to outlive the call, and the transcript is ours.
    store: false,
  };
  if (req.system) params.instructions = req.system;
  if (req.tools?.length) {
    params.tools = toResponsesTools(req.tools);
    // One call per turn unless asked otherwise: the model reads each result
    // before choosing the next call, instead of firing a whole plan blind.
    params.parallel_tool_calls = spec.parallelToolCalls === true;
  }
  // Only when asked for: a non-reasoning model rejects the field outright.
  if (spec.effort) {
    params.reasoning = {
      effort: toReasoningEffort(spec.effort),
      // Asked for so a reader can be shown what the model is working out.
      // Models that produce none simply send no summary events.
      summary: "detailed",
    };
  }
  return params;
}

function stopReasonFor(
  response: OpenAI.Responses.Response,
  hasToolCall: boolean,
  hasRefusal: boolean,
): StopReason {
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "max_output_tokens"
      ? "max_tokens"
      : "other";
  }
  if (hasRefusal) return "refusal";
  return hasToolCall ? "tool_use" : "end_turn";
}

export function fromResponsesResponse(
  response: OpenAI.Responses.Response,
): ModelResponse {
  const content: ContentBlock[] = [];
  let hasToolCall = false;
  let hasRefusal = false;

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content.push({ type: "text", text: part.text });
        }
        if (part.type === "refusal") hasRefusal = true;
      }
      continue;
    }
    if (item.type === "function_call") {
      hasToolCall = true;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
      } catch {
        // Malformed arguments reach the tool, which reports what was wrong;
        // dropping the call instead would look like it was never made.
        input = { _raw: item.arguments };
      }
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: fromOpenAIToolName(item.name),
        input,
      });
    }
  }

  return {
    content,
    stopReason: stopReasonFor(response, hasToolCall, hasRefusal),
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      /*
       * OpenAI caches a repeated prefix by itself, with no parameter to set,
       * and bills the reused part at a discount. It says how much in
       * input_tokens_details, which was read as nothing -- so a long
       * conversation, which is mostly reused prefix, was priced as though
       * every token were fresh.
       */
      ...(response.usage?.input_tokens_details?.cached_tokens
        ? { cacheReadTokens: response.usage.input_tokens_details.cached_tokens }
        : {}),
    },
    model: response.model,
  };
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly keyName = "openai";

  async generate(
    req: GenerateRequest,
    spec: ModelSpec,
    apiKey: string,
  ): Promise<ModelResponse> {
    const client = new OpenAI({ apiKey });
    const params = buildResponsesParams(req, spec);
    if (!req.onDelta) {
      return fromResponsesResponse(
        await client.responses.create(
          params,
          ...(req.signal ? [{ signal: req.signal }] : []),
        ),
      );
    }

    // Streamed only when someone is watching. The completed event carries the
    // whole response, so the reply is still assembled by the provider rather
    // than stitched together from deltas here.
    const stream = await client.responses.create(
      { ...params, stream: true },
      ...(req.signal ? [{ signal: req.signal }] : []),
    );
    let final: OpenAI.Responses.Response | undefined;
    let reasoning = "";
    for await (const event of stream) {
      switch (event.type) {
        case "response.reasoning_summary_text.delta":
          reasoning += event.delta;
          req.onDelta({ kind: "reasoning", text: event.delta });
          break;
        case "response.output_text.delta":
          req.onDelta({ kind: "text", text: event.delta });
          break;
        case "response.completed":
        case "response.incomplete":
          final = event.response;
          break;
        default:
          break;
      }
    }
    if (!final) throw new Error("stream ended without a completed response");
    const response = fromResponsesResponse(final);
    // Kept so the turn can be read back later, not only watched live.
    if (reasoning.trim()) {
      response.content.unshift({ type: "reasoning", text: reasoning });
    }
    return response;
  }
}
