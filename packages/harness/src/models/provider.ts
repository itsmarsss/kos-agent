import type { GenerateRequest, ModelResponse } from "./types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSpec {
  /** Provider-specific model id, e.g. "claude-opus-4-8". */
  model: string;
  maxTokens?: number;
  effort?: Effort;
  thinking?: "adaptive" | "disabled";
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
