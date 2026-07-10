import OpenAI from "openai";

import type { ModelSpec, Provider } from "../provider.js";
import type {
  ContentBlock,
  GenerateRequest,
  ModelMessage,
  ModelResponse,
  StopReason,
} from "../types.js";

const DEFAULT_MAX_TOKENS = 16000;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

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

/** Map one internal message to one or more OpenAI chat messages. */
function toChatMessages(message: ModelMessage): ChatMessage[] {
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");

  if (message.role === "assistant") {
    const toolCalls = message.content
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        const t = b as { id: string; name: string; input: unknown };
        return {
          id: t.id,
          type: "function" as const,
          function: {
            name: toOpenAIToolName(t.name),
            arguments: JSON.stringify(t.input),
          },
        };
      });
    const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: text || null,
    };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    return [msg];
  }

  // user role: tool results become separate `tool` messages.
  const results = message.content.filter((b) => b.type === "tool_result");
  if (results.length) {
    return results.map((b) => {
      const r = b as { toolUseId: string; content: string };
      return { role: "tool", tool_call_id: r.toolUseId, content: r.content };
    });
  }
  return [{ role: "user", content: text }];
}

export function toOpenAIMessages(
  system: string | undefined,
  messages: ModelMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) out.push(...toChatMessages(m));
  return out;
}

export function toOpenAITools(
  tools: NonNullable<GenerateRequest["tools"]>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: toOpenAIToolName(t.name),
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
export function buildOpenAIParams(
  req: GenerateRequest,
  spec: ModelSpec,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
    {
      model: spec.model,
      max_completion_tokens: spec.maxTokens ?? req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toOpenAIMessages(req.system, req.messages),
    };
  if (req.tools?.length) params.tools = toOpenAITools(req.tools);
  return params;
}

export function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

export function fromOpenAIResponse(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): ModelResponse {
  const choice = completion.choices[0];
  const content: ContentBlock[] = [];
  const msg = choice?.message;
  if (msg?.content) content.push({ type: "text", text: msg.content });
  for (const call of msg?.tool_calls ?? []) {
    if (call.type !== "function") continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || "{}") as Record<
        string,
        unknown
      >;
    } catch {
      input = { _raw: call.function.arguments };
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: fromOpenAIToolName(call.function.name),
      input,
    });
  }
  return {
    content,
    stopReason: mapFinishReason(choice?.finish_reason ?? null),
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
    model: completion.model,
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
    const completion = await client.chat.completions.create(
      buildOpenAIParams(req, spec),
    );
    return fromOpenAIResponse(completion);
  }
}
