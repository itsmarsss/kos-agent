import Anthropic from "@anthropic-ai/sdk";

import type { Effort, ModelSpec, Provider } from "../provider.js";
import type {
  ContentBlock,
  GenerateRequest,
  ModelMessage,
  ModelResponse,
  StopReason,
} from "../types.js";

const DEFAULT_MAX_TOKENS = 16000;

type AnthropicBlockParam = Anthropic.Messages.ContentBlockParam;

/** Map internal content blocks to Anthropic message-param blocks. */
function toAnthropicContent(blocks: ContentBlock[]): AnthropicBlockParam[] {
  const out: AnthropicBlockParam[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "tool_use":
        out.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        });
        break;
      case "file":
        out.push({
          type: "text",
          text: `Attached file ${block.name}:\n\n${block.text}`,
        });
        break;
      case "reasoning":
        // For the reader only. Anthropic owns its own thinking blocks, and a
        // summary written by another provider is not one of them.
        break;
      case "image":
        out.push({
          type: "image",
          source: {
            type: "base64",
            media_type: block.mediaType as "image/png",
            data: block.data,
          },
        });
        break;
      case "thinking":
        // Echo the provider-native thinking block back exactly as received.
        out.push(block.raw as AnthropicBlockParam);
        break;
    }
  }
  return out;
}

export function toAnthropicMessages(
  messages: ModelMessage[],
): Anthropic.Messages.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: toAnthropicContent(m.content),
  }));
}

export function toAnthropicTools(
  tools: NonNullable<GenerateRequest["tools"]>,
): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
  }));
}

/**
 * Where to tell Anthropic it may reuse what it has already read.
 *
 * A turn re-sends the whole prompt: the tools, the system prompt, and every
 * previous message. In an agent loop that happens once per tool round-trip,
 * so a conversation of any length pays full input price for the same text
 * over and over. Marked with a breakpoint, everything up to the mark is
 * served from cache at a tenth of the price on the next call.
 *
 * Three marks, of the four allowed. Tools and system are the stable prefix
 * and are worth their own so they still hit when the conversation moves on;
 * the last message extends the cache to cover the history as it grows.
 *
 * Always safe to set: a prefix shorter than the model's minimum is ignored
 * rather than refused, so a short chat simply does not benefit.
 */
const CACHE: Anthropic.Messages.CacheControlEphemeral = { type: "ephemeral" };

/** Block kinds that carry a breakpoint. A thinking block is the model's own. */
function acceptsCache(block: AnthropicBlockParam): boolean {
  return (
    block.type === "text" ||
    block.type === "tool_result" ||
    block.type === "tool_use" ||
    block.type === "image"
  );
}

/**
 * Mark the end of the conversation so far.
 *
 * The next call in the loop sends everything here plus one more result, so
 * this is the boundary it will read back rather than re-pay for.
 */
function cacheLastMessage(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (typeof message.content === "string") continue;
    const blocks = message.content;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]!;
      if (!acceptsCache(block)) continue;
      const marked = [...blocks];
      marked[j] = { ...block, cache_control: CACHE } as AnthropicBlockParam;
      const copy = [...messages];
      copy[i] = { ...message, content: marked };
      return copy;
    }
  }
  return messages;
}

export function buildAnthropicParams(
  req: GenerateRequest,
  spec: ModelSpec,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: spec.model,
    max_tokens: spec.maxTokens ?? req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: cacheLastMessage(toAnthropicMessages(req.messages)),
  };
  if (req.system) {
    // As a block rather than a string, which is the only shape that carries
    // a breakpoint.
    params.system = [{ type: "text", text: req.system, cache_control: CACHE }];
  }
  if (req.tools?.length) {
    const tools = toAnthropicTools(req.tools);
    const last = tools[tools.length - 1];
    if (last) tools[tools.length - 1] = { ...last, cache_control: CACHE };
    params.tools = tools;
    if (spec.parallelToolCalls !== true) {
      // Same reason as the OpenAI side: one call, one result, then decide.
      params.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }
  if (spec.thinking === "adaptive") {
    params.thinking = { type: "adaptive" };
  } else if (spec.thinking === "disabled") {
    params.thinking = { type: "disabled" };
  }
  if (spec.effort) {
    params.output_config = { effort: spec.effort as Effort };
  }
  return params;
}

export function mapStopReason(
  reason: Anthropic.Messages.Message["stop_reason"],
): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export function fromAnthropicResponse(
  message: Anthropic.Messages.Message,
): ModelResponse {
  const content: ContentBlock[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "tool_use":
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
        break;
      case "thinking":
      case "redacted_thinking":
        content.push({ type: "thinking", raw: block });
        break;
      default:
        break;
    }
  }
  return {
    content,
    stopReason: mapStopReason(message.stop_reason),
    usage: {
      /*
       * Anthropic reports the cached parts alongside the fresh ones rather
       * than inside them, so input is the sum. Counted as fresh input, the
       * cache we just asked for would have looked like no saving at all.
       */
      inputTokens:
        message.usage.input_tokens +
        (message.usage.cache_read_input_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      ...(message.usage.cache_read_input_tokens
        ? { cacheReadTokens: message.usage.cache_read_input_tokens }
        : {}),
      ...(message.usage.cache_creation_input_tokens
        ? { cacheWriteTokens: message.usage.cache_creation_input_tokens }
        : {}),
    },
    model: message.model,
  };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly keyName = "anthropic";

  async generate(
    req: GenerateRequest,
    spec: ModelSpec,
    apiKey: string,
  ): Promise<ModelResponse> {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create(
      buildAnthropicParams(req, spec),
      ...(req.signal ? [{ signal: req.signal }] : []),
    );
    return fromAnthropicResponse(message);
  }
}
