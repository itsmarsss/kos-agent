import { describe, expect, it } from "vitest";

import { SecretsRegistry } from "../secrets/secrets.js";
import type { ModelSpec, Provider } from "./provider.js";
import { ModelRouter, type RoutingTable } from "./router.js";
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
