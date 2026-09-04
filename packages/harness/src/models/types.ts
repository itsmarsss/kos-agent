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

/**
 * An image the owner attached, carried as a data URI rather than a link.
 *
 * The workspace is not reachable from a provider, and a path in a transcript
 * is only meaningful to the process that wrote it. Bytes travel with the
 * message, so a turn replayed later still has the picture it was about.
 */
export interface ImageBlock {
  type: "image";
  /** The filename it was attached under, so a reader sees what they sent. */
  name?: string;
  /** Image media type, e.g. "image/png". */
  mediaType: string;
  /** Base64 payload, without the data: prefix. */
  data: string;
}

/**
 * The model's own account of what it worked out, in plain text.
 *
 * Distinct from ThinkingBlock, which is a provider-native payload echoed back
 * verbatim. This one is for the reader: it is kept in the transcript so a turn
 * can be understood after the fact, and never sent back to any provider.
 */
export interface ReasoningBlock {
  type: "reasoning";
  text: string;
}

/**
 * A text file the owner attached, kept as a file rather than flattened.
 *
 * Providers see its contents as text, because that is all a model can read.
 * The transcript keeps the name and the bytes, so the reader gets a thing they
 * attached and can open, not an anonymous wall of text in their own message.
 */
export interface FileBlock {
  type: "file";
  name: string;
  text: string;
}

export type ContentBlock =
  | TextBlock
  | FileBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ReasoningBlock
  | ImageBlock;

export interface ModelMessage {
  role: Role;
  content: ContentBlock[];
}

/**
 * A piece of the answer as it is produced.
 *
 * "reasoning" is the model's own summary of what it is working out, where the
 * provider offers one; "text" is the reply itself. Both exist so a reader
 * watching a turn sees it happening rather than a static word for the whole
 * of it.
 */
export interface GenerateDelta {
  kind: "reasoning" | "text";
  text: string;
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
  /**
   * Called as the answer is produced. Providers that cannot stream ignore it
   * and return the whole reply at the end, so a caller may always pass one.
   */
  onDelta?: (delta: GenerateDelta) => void;
  /**
   * Abandon the call.
   *
   * Stopping used to be checked between round trips only, so asking a turn
   * to stop while it was waiting on the model did nothing until the model
   * had finished answering -- and for a turn that was one call, nothing at
   * all. The request itself is dropped now.
   */
  signal?: AbortSignal;
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
