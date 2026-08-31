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
 * OpenAI-only table used when Anthropic is not configured.
 *
 * Mirrors the Anthropic default: a reasoning model at high effort for real
 * turns, a small one for salience. Both need the Responses API, which is what
 * the provider speaks; on Chat Completions an effort could not be sent
 * alongside function tools at all, and gpt-5.6 refused tools outright.
 */
export const OPENAI_ROUTING: RoutingTable = {
  reasoning: {
    provider: "openai",
    spec: { model: "gpt-5.6-terra", effort: "high" },
  },
  cheap: {
    provider: "openai",
    spec: { model: "gpt-5.4-mini", effort: "low" },
  },
};

/**
 * Pick a routing table from available secrets. Prefer Anthropic when its key
 * is present; otherwise fall back to OpenAI so a single-provider .env works.
 */
export function routingForSecrets(secrets: SecretsRegistry): RoutingTable {
  if (secrets.has("anthropic")) return DEFAULT_ROUTING;
  if (secrets.has("openai")) return OPENAI_ROUTING;
  return DEFAULT_ROUTING;
}

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

  /**
   * Which model answers each task class.
   *
   * The table is chosen from whichever API keys are present, so a workspace
   * with one provider silently gets a different agent from the default. Read
   * by status so that is visible rather than something you find out by
   * reading the router.
   */
  describeRoutes(): Record<Task, { provider: string; model: string }> {
    const out = {} as Record<Task, { provider: string; model: string }>;
    for (const task of Object.keys(this.routing) as Task[]) {
      const route = this.routing[task];
      out[task] = { provider: route.provider, model: route.spec.model };
    }
    return out;
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

/**
 * Wire the default router: Anthropic + OpenAI providers. When `routing` is
 * omitted, pick Anthropic or OpenAI based on which API keys are present.
 */
export function createDefaultRouter(
  secrets: SecretsRegistry,
  routing?: RoutingTable,
): ModelRouter {
  return new ModelRouter(
    [new AnthropicProvider(), new OpenAIProvider()],
    routing ?? routingForSecrets(secrets),
    secrets,
  );
}
