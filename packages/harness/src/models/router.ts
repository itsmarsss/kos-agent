import type { SecretsRegistry } from "../secrets/secrets.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import type { ModelSpec, Provider } from "./provider.js";
import type { GenerateRequest, ModelResponse } from "./types.js";

/**
 * A task class. The router maps each task to a provider and model so callers
 * ask for capability ("reasoning") rather than naming a model. Cheap tasks
 * (salience, heuristics) route to a small model; reasoning and self_prompt to a
 * stronger one.
 */
export type Task = "reasoning" | "cheap";

export interface Route {
  provider: string;
  spec: ModelSpec;
}

export type RoutingTable = Record<Task, Route>;

export const DEFAULT_ROUTING: RoutingTable = {
  reasoning: {
    provider: "anthropic",
    spec: { model: "claude-opus-4-8", thinking: "adaptive", effort: "high" },
  },
  cheap: {
    provider: "anthropic",
    spec: { model: "claude-haiku-4-5", thinking: "disabled" },
  },
};

/**
 * The single inference entry point. Everything in KOS calls the router, never a
 * provider directly, so the host/provider decision stays a config change.
 */
export class ModelRouter {
  private readonly providers: Map<string, Provider>;

  constructor(
    providers: Provider[],
    private readonly routing: RoutingTable,
    private readonly secrets: SecretsRegistry,
  ) {
    this.providers = new Map(providers.map((p) => [p.name, p]));
  }

  async generate(task: Task, req: GenerateRequest): Promise<ModelResponse> {
    const route = this.routing[task];
    const provider = this.providers.get(route.provider);
    if (!provider) {
      throw new Error(`no provider registered for route: ${route.provider}`);
    }
    const apiKey = this.secrets.require(provider.keyName);
    return provider.generate(req, route.spec, apiKey);
  }
}

/** Wire the default router: Anthropic + OpenAI providers, default routing. */
export function createDefaultRouter(
  secrets: SecretsRegistry,
  routing: RoutingTable = DEFAULT_ROUTING,
): ModelRouter {
  return new ModelRouter(
    [new AnthropicProvider(), new OpenAIProvider()],
    routing,
    secrets,
  );
}
