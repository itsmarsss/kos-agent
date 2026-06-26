/**
 * Internal, provider-neutral model types. Every provider adapter normalizes to
 * and from these shapes so the rest of KOS speaks one tool-call protocol
 * regardless of which provider (Anthropic, OpenAI, local) served the request.
 */

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * An opaque provider-native reasoning block (Anthropic thinking /
 * redacted_thinking). Stored verbatim in `raw` so it can be echoed back to the
 * same model unchanged on the next turn, as the provider requires. Providers
 * that do not understand thinking blocks ignore them in both directions.
 */
export interface ThinkingBlock {
  type: "thinking";
  raw: unknown;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

export interface ModelMessage {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateRequest {
  system?: string;
  messages: ModelMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
}

/** Convenience: pull the concatenated text out of a content block list. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Convenience: all tool-use blocks in a content block list. */
export function toolUsesOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}
