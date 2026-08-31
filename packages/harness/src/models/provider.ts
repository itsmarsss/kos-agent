import type { GenerateRequest, ModelResponse } from "./types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSpec {
  /** Provider-specific model id, e.g. "claude-opus-4-8". */
  model: string;
  maxTokens?: number;
  effort?: Effort;
  thinking?: "adaptive" | "disabled";
  /**
   * Let the model emit several tool calls in one response. Off by default: it
   * fires a whole plan before seeing any of it come back, so a wrong first
   * assumption is carried through every call in the batch. One at a time
   * means each result is read before the next call is chosen.
   */
  parallelToolCalls?: boolean;
}

/**
 * A model provider adapter. Translates the internal GenerateRequest to the
 * provider's wire format, calls the provider, and normalizes the reply back to
 * a ModelResponse. The API key is injected by the router at call time; the
 * adapter never resolves secrets itself.
 */
export interface Provider {
  readonly name: string;
  /** Secret name under which this provider's API key is registered. */
  readonly keyName: string;
  generate(
    req: GenerateRequest,
    spec: ModelSpec,
    apiKey: string,
  ): Promise<ModelResponse>;
}
