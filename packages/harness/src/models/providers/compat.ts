import OpenAI from "openai";

import type { ModelSpec, Provider } from "../provider.js";
import type { ContentBlock, GenerateRequest, ModelMessage, ModelResponse, StopReason } from "../types.js";
import { fromOpenAIToolName, toOpenAIToolName } from "./openai.js";

/**
 * Any OpenAI-compatible endpoint: the owner's own model, a local server,
 * a gateway. A URL and, if it wants one, a key.
 *
 * Chat Completions rather than Responses, because that is what vLLM,
 * Ollama, LM Studio, llama.cpp, OpenRouter and the rest speak. Tool calls
 * go through as functions; a model without tool support simply answers in
 * text. Prompt caching and reasoning summaries are the big providers'
 * business, not this one's.
 */

export const CUSTOM_PROVIDER = "custom";
const DEFAULT_MAX_TOKENS = 8000;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function textOf(content: ModelMessage["content"]): string {
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "file" ? `Attached file ${b.name}:\n\n${b.text}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function toChatMessages(req: GenerateRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "tool_use") as { id: string; name: string; input: unknown }[];
      const text = textOf(m.content);
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: toOpenAIToolName(c.name), arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
      continue;
    }
    const results = m.content.filter((b) => b.type === "tool_result") as { toolUseId: string; content: string }[];
    for (const r of results) out.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
    if (results.length === 0) {
      const images = m.content.filter((b) => b.type === "image") as { mediaType: string; data: string }[];
      const text = textOf(m.content);
      if (images.length === 0) out.push({ role: "user", content: text });
      else
        out.push({
          role: "user",
          content: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
          ],
        });
    }
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

function stopFor(finish: string | null | undefined, hasToolCall: boolean): StopReason {
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  return hasToolCall ? "tool_use" : "end_turn";
}

export class OpenAICompatibleProvider implements Provider {
  readonly name = CUSTOM_PROVIDER;
  readonly keyName = CUSTOM_PROVIDER;
  /** A local server often wants no key at all. */
  readonly optionalKey = true;

  constructor(readonly baseURL: string) {}

  async generate(req: GenerateRequest, spec: ModelSpec, apiKey: string): Promise<ModelResponse> {
    const client = new OpenAI({ apiKey: apiKey || "none", baseURL: this.baseURL });
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: spec.model,
      messages: toChatMessages(req),
      max_tokens: spec.maxTokens ?? req.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        type: "function" as const,
        function: { name: toOpenAIToolName(t.name), description: t.description, parameters: t.inputSchema as Record<string, unknown> },
      }));
      params.parallel_tool_calls = spec.parallelToolCalls === true;
    }
    // No reasoning_effort: an effort inherited from a big-provider route
    // would be sent to a server that may not know the field. The owner's
    // endpoint gets the model id and the messages, nothing it did not ask for.
    const options = req.signal ? { signal: req.signal } : {};

    if (!req.onDelta) {
      const res = await client.chat.completions.create(params, options);
      const choice = res.choices[0];
      const content: ContentBlock[] = [];
      const text = choice?.message.content;
      if (text) content.push({ type: "text", text });
      for (const call of choice?.message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        content.push({ type: "tool_use", id: call.id, name: fromOpenAIToolName(call.function.name), input: parseArgs(call.function.arguments) });
      }
      return {
        content,
        stopReason: stopFor(choice?.finish_reason, content.some((b) => b.type === "tool_use")),
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
        model: res.model,
      };
    }

    const stream = await client.chat.completions.create({ ...params, stream: true, stream_options: { include_usage: true } }, options);
    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let model = spec.model;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.model) model = chunk.model;
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (delta.content) {
        text += delta.content;
        req.onDelta({ kind: "text", text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: tc.id ?? "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        calls.set(tc.index, slot);
      }
    }
    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      content.push({ type: "tool_use", id: c.id || `call_${content.length}`, name: fromOpenAIToolName(c.name), input: parseArgs(c.args) });
    }
    return {
      content,
      stopReason: stopFor(finish, calls.size > 0),
      usage: { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 },
      model,
    };
  }

  /** The models the endpoint says it serves. */
  async listModels(apiKey: string): Promise<string[]> {
    const client = new OpenAI({ apiKey: apiKey || "none", baseURL: this.baseURL });
    const page = await client.models.list();
    const ids: string[] = [];
    for await (const m of page) ids.push(m.id);
    return ids.sort();
  }
}
