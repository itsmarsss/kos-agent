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

export function buildAnthropicParams(
  req: GenerateRequest,
  spec: ModelSpec,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: spec.model,
    max_tokens: spec.maxTokens ?? req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(req.messages),
  };
  if (req.system) params.system = req.system;
  if (req.tools?.length) {
    params.tools = toAnthropicTools(req.tools);
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
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
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
    const message = await client.messages.create(buildAnthropicParams(req, spec));
    return fromAnthropicResponse(message);
  }
}
