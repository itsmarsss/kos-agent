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

/** A route as shown to a reader: what answers, how hard, and how much. */
export interface RouteSummary {
  provider: string;
  model: string;
  effort?: string;
  maxTokens?: number;
}

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

  /**
   * Told about every response's token usage.
   *
   * Set here rather than at each call site because this is the one place that
   * knows both which model answered and what it reported using, and because
   * everything routes through it: a turn, a compaction, a salience check and a
   * cron run all get counted without each remembering to.
   */
  onUsage?: (event: {
    task: Task;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }) => void;

  constructor(
    providers: Provider[],
    private routing: RoutingTable,
    private readonly secrets: SecretsRegistry,
  ) {
    this.providers = new Map(providers.map((p) => [p.name, p]));
  }

  /**
   * Point a task class at a different model. Applied in place so a change the
   * owner makes takes effect on the next turn rather than the next restart.
   */
  setRoute(task: Task, route: Route): void {
    if (!this.providers.has(route.provider)) {
      throw new Error(`no provider registered for route: ${route.provider}`);
    }
    this.routing = { ...this.routing, [task]: route };
  }

  /** The full spec for a task, so a caller can show what is set. */
  routeFor(task: Task): Route {
    return this.routing[task];
  }

  /**
   * Which model answers each task class.
   *
   * The table is chosen from whichever API keys are present, so a workspace
   * with one provider silently gets a different agent from the default. Read
   * by status so that is visible rather than something you find out by
   * reading the router.
   */
  describeRoutes(): Record<Task, RouteSummary> {
    const out = {} as Record<Task, RouteSummary>;
    for (const task of Object.keys(this.routing) as Task[]) {
      const route = this.routing[task];
      out[task] = {
        provider: route.provider,
        model: route.spec.model,
        // Effort and the token cap are what the owner set in the dashboard, so
        // it has to be able to read back what is actually in force.
        ...(route.spec.effort ? { effort: route.spec.effort } : {}),
        ...(route.spec.maxTokens ? { maxTokens: route.spec.maxTokens } : {}),
      };
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
    const response = await provider.generate(req, route.spec, apiKey);
    try {
      this.onUsage?.({
        task,
        provider: route.provider,
        model: route.spec.model,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
        ...(response.usage?.cacheReadTokens
          ? { cacheReadTokens: response.usage.cacheReadTokens }
          : {}),
        ...(response.usage?.cacheWriteTokens
          ? { cacheWriteTokens: response.usage.cacheWriteTokens }
          : {}),
      });
    } catch {
      // Accounting must never be able to fail a turn that already succeeded.
    }
    return response;
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
