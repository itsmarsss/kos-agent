import { describe, expect, it } from "vitest";

import { SecretsRegistry } from "../secrets/secrets.js";
import type { ModelSpec, Provider } from "./provider.js";
import {
  DEFAULT_ROUTING,
  ModelRouter,
  OPENAI_ROUTING,
  createDefaultRouter,
  retryAfterMs,
  routingForSecrets,
  type RoutingTable,
} from "./router.js";
import type { GenerateRequest, ModelResponse } from "./types.js";

class MockProvider implements Provider {
  calls: { spec: ModelSpec; apiKey: string }[] = [];
  constructor(
    readonly name: string,
    readonly keyName: string,
  ) {}
  async generate(
    _req: GenerateRequest,
    spec: ModelSpec,
    apiKey: string,
  ): Promise<ModelResponse> {
    this.calls.push({ spec, apiKey });
    return {
      content: [{ type: "text", text: `${this.name}:${spec.model}` }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: spec.model,
    };
  }
}

const routing: RoutingTable = {
  reasoning: { provider: "anthropic", spec: { model: "claude-opus-4-8" } },
  cheap: { provider: "openai", spec: { model: "gpt-x" } },
  screen: { provider: "anthropic", spec: { model: "claude-sonnet-5-5" } },
};

const req: GenerateRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("ModelRouter", () => {
  it("routes a task to its provider and injects the resolved key", async () => {
    const anthropic = new MockProvider("anthropic", "anthropic");
    const openai = new MockProvider("openai", "openai");
    const secrets = new SecretsRegistry({ anthropic: "sk-a", openai: "sk-o" });
    const router = new ModelRouter([anthropic, openai], routing, secrets);

    const res = await router.generate("reasoning", req);
    expect(res.model).toBe("claude-opus-4-8");
    expect(anthropic.calls).toHaveLength(1);
    expect(anthropic.calls[0]?.apiKey).toBe("sk-a");
    expect(openai.calls).toHaveLength(0);
  });

  it("routes the cheap task to the other provider", async () => {
    const anthropic = new MockProvider("anthropic", "anthropic");
    const openai = new MockProvider("openai", "openai");
    const secrets = new SecretsRegistry({ anthropic: "sk-a", openai: "sk-o" });
    const router = new ModelRouter([anthropic, openai], routing, secrets);

    await router.generate("cheap", req);
    expect(openai.calls[0]?.apiKey).toBe("sk-o");
  });

  it("throws when the routed provider is not registered", async () => {
    const secrets = new SecretsRegistry({ anthropic: "sk-a" });
    const router = new ModelRouter([], routing, secrets);
    await expect(router.generate("reasoning", req)).rejects.toThrow(
      /no provider registered/,
    );
  });

  it("throws when the provider key is missing from secrets", async () => {
    const anthropic = new MockProvider("anthropic", "anthropic");
    const router = new ModelRouter([anthropic], routing, new SecretsRegistry());
    await expect(router.generate("reasoning", req)).rejects.toThrow(
      /secret not found/,
    );
  });
});

describe("routingForSecrets", () => {
  it("prefers Anthropic when its key is present", () => {
    const secrets = new SecretsRegistry({ anthropic: "a", openai: "o" });
    expect(routingForSecrets(secrets)).toBe(DEFAULT_ROUTING);
  });

  it("falls back to OpenAI when only openai is present", () => {
    const secrets = new SecretsRegistry({ openai: "o" });
    expect(routingForSecrets(secrets)).toBe(OPENAI_ROUTING);
  });

  it("defaults to Anthropic routing when no keys are set", () => {
    expect(routingForSecrets(new SecretsRegistry())).toBe(DEFAULT_ROUTING);
  });
});

describe("createDefaultRouter", () => {
  it("routes through OpenAI when only OPENAI_API_KEY is available", async () => {
    const secrets = SecretsRegistry.fromEnv({
      OPENAI_API_KEY: "sk-oai",
    } as NodeJS.ProcessEnv);
    const router = createDefaultRouter(secrets);
    // Live call is not made: we only assert the routing table choice.
    expect(routingForSecrets(secrets).reasoning.provider).toBe("openai");
    expect(router).toBeInstanceOf(ModelRouter);
  });
});

describe("describeRoutes", () => {
  it("reports the table actually in use", () => {
    // A workspace with only an OpenAI key silently runs gpt-4o where the
    // default is claude-opus-4-8, and nothing anywhere said so.
    const secrets = new SecretsRegistry();
    secrets.set("openai", "sk-test");
    const router = createDefaultRouter(secrets);
    // The effort is part of the route, and the dashboard shows it back.
    expect(router.describeRoutes()).toEqual({
      reasoning: { provider: "openai", model: "gpt-5.6-terra", effort: "high" },
      cheap: { provider: "openai", model: "gpt-5.4-mini", effort: "low" },
      screen: { provider: "openai", model: "gpt-5.6-terra", effort: "high" },
    });
  });

  it("runs screen work on the reasoning route until the owner gives it one of its own", () => {
    const secrets = new SecretsRegistry();
    secrets.set("anthropic", "sk-ant-test");
    const router = createDefaultRouter(secrets);
    expect(router.routeFor("screen")).toEqual(router.routeFor("reasoning"));
    router.setRoute("reasoning", { provider: "anthropic", spec: { model: "claude-opus-5" } });
    expect(router.routeFor("screen").spec.model).toBe("claude-opus-5");
    router.setRoute("screen", { provider: "anthropic", spec: { model: "claude-sonnet-5-5", effort: "low" } });
    expect(router.describeRoutes().screen).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" });
  });

  it("reports the anthropic table when that key is present", () => {
    const secrets = new SecretsRegistry();
    secrets.set("anthropic", "sk-ant-test");
    expect(createDefaultRouter(secrets).describeRoutes().reasoning).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      effort: "high",
    });
  });
});

/** A provider that fails with the given errors first, then answers; it can say a word before failing. */
class FlakyProvider extends MockProvider {
  constructor(private readonly failures: string[], private readonly speakFirst = false) {
    super("openai", "openai");
  }
  override async generate(req: GenerateRequest, spec: ModelSpec, apiKey: string): Promise<ModelResponse> {
    const failure = this.failures.shift();
    if (failure !== undefined) {
      this.calls.push({ spec, apiKey });
      if (this.speakFirst) req.onDelta?.({ kind: "text", text: "Half" });
      throw new Error(failure);
    }
    return super.generate(req, spec, apiKey);
  }
}

describe("asking a model again", () => {
  const RATE = "Rate limit reached for gpt-5.5 on tokens per min (TPM): Limit 1000000, Used 951576, Requested 55584. Please try again in 429ms.";
  const routed: RoutingTable = { reasoning: { provider: "openai", spec: { model: "gpt-x" } }, cheap: { provider: "openai", spec: { model: "gpt-x" } }, screen: { provider: "openai", spec: { model: "gpt-x" } } };
  const secrets = (): SecretsRegistry => {
    const s = new SecretsRegistry();
    s.set("openai", "sk-o");
    return s;
  };
  const routerFor = (provider: Provider): { router: ModelRouter; waits: number[] } => {
    const router = new ModelRouter([provider], routed, secrets());
    const waits: number[] = [];
    router.wait = async (ms) => {
      waits.push(ms);
    };
    return { router, waits };
  };

  it("waits and asks again when the provider is rate limited or the stream drops", async () => {
    const flaky = new FlakyProvider([RATE, "terminated"]);
    const { router, waits } = routerFor(flaky);
    const res = await router.generate("reasoning", req);
    expect(res.model).toBe("gpt-x");
    expect(flaky.calls).toHaveLength(3);
    // Longer each time, and never shorter than the provider asked.
    expect(waits).toEqual([2000, 8000]);
  });

  it("gives up after a few tries, and never retries what is not the way there", async () => {
    const always = new FlakyProvider([RATE, RATE, RATE, RATE, RATE]);
    await expect(routerFor(always).router.generate("reasoning", req)).rejects.toThrow(/Rate limit/);
    expect(always.calls).toHaveLength(4);
    const bad = new FlakyProvider(["400 invalid model: gpt-x"]);
    await expect(routerFor(bad).router.generate("reasoning", req)).rejects.toThrow(/invalid model/);
    expect(bad.calls).toHaveLength(1);
  });

  it("does not ask again once part of the answer has gone out, or when the turn was stopped", async () => {
    const spoke = new FlakyProvider(["terminated"], true);
    const said: string[] = [];
    await expect(routerFor(spoke).router.generate("reasoning", { ...req, onDelta: (d) => said.push(d.text) })).rejects.toThrow(/terminated/);
    expect(spoke.calls).toHaveLength(1);
    expect(said).toEqual(["Half"]);
    const stopped = new AbortController();
    stopped.abort();
    const flaky = new FlakyProvider([RATE]);
    await expect(routerFor(flaky).router.generate("reasoning", { ...req, signal: stopped.signal })).rejects.toThrow(/Rate limit/);
    expect(flaky.calls).toHaveLength(1);
  });

  it("reads how long the provider asked to be left", () => {
    expect(retryAfterMs(RATE)).toBe(429);
    expect(retryAfterMs("Please try again in 1.5s.")).toBe(1500);
    expect(retryAfterMs("terminated")).toBeUndefined();
  });
});
