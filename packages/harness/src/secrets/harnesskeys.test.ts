import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelSpec, Provider } from "../models/provider.js";
import { ModelRouter, routingForSecrets } from "../models/router.js";
import type { GenerateRequest, ModelResponse } from "../models/types.js";
import { harnessNameOf, SecretsRegistry } from "./secrets.js";
import { Vault } from "./vault.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kos-harness-keys-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PASS = "a long passphrase";

async function vaultWith(keys: Record<string, string>, passphrase?: string): Promise<Vault> {
  const vault = new Vault({ dir: join(root, "secrets") });
  await vault.init(passphrase ? { passphrase } : {});
  for (const [name, token] of Object.entries(keys)) vault.add({ label: `KOS ${name}`, kind: "apikey", values: { token }, use: { harness: name } });
  return vault;
}

describe("keys KOS runs on, from the env or the vault", () => {
  it("names each env key by its harness name", () => {
    expect(harnessNameOf("OPENAI_API_KEY")).toBe("openai");
    expect(harnessNameOf("DISCORD_TOKEN")).toBe("discord");
    expect(harnessNameOf("TWILIO_AUTH_TOKEN")).toBe("twilio");
    expect(harnessNameOf("KOS_SECRET_STRIPE")).toBe("stripe");
    expect(harnessNameOf("KOS_SECRET_STRIPE_HOSTS")).toBeUndefined();
    expect(harnessNameOf("KOS_SECRET_STRIPE_MCP")).toBeUndefined();
    expect(harnessNameOf("KOS_PORT")).toBeUndefined();
  });

  it("reads the vault's key when the env has none, and the env's when it has one", async () => {
    const vault = await vaultWith({ openai: "sk-proj-vault-0123456789", discord: "discord-vault-token-0123456789", stripe: "sk_live_vault_0123456789" });
    const secrets = SecretsRegistry.fromEnv({ DISCORD_TOKEN: "discord-env-token-0123456789" } as NodeJS.ProcessEnv);
    secrets.attachVault(vault);
    expect(secrets.get("openai")).toBe("sk-proj-vault-0123456789");
    expect(secrets.credential("openai")).toBe("sk-proj-vault-0123456789");
    expect(secrets.sourceOf("openai")).toMatchObject({ source: "vault", label: "KOS openai" });
    // The env wins, under any of the names it is read by.
    expect(secrets.credential("discord")).toBe("discord-env-token-0123456789");
    expect(secrets.sourceOf("discord")).toEqual({ source: "env", env: "DISCORD_TOKEN" });
    expect(secrets.get("discord")).toBeUndefined();
    // A provider key from the vault goes where the env's would; any other where its entry or _HOSTS says.
    expect(secrets.hostsOf("openai")).toEqual(["api.openai.com"]);
    expect(secrets.hostsOf("stripe")).toBeUndefined();
    expect(secrets.inVault("stripe")).toBe(true);
    const bound = SecretsRegistry.fromEnv({ KOS_SECRET_STRIPE_HOSTS: "api.stripe.com" } as NodeJS.ProcessEnv);
    bound.attachVault(vault);
    expect(bound.hostsOf("stripe")).toEqual(["api.stripe.com"]);
    const both = SecretsRegistry.fromEnv({ OPENAI_API_KEY: "sk-proj-env-0123456789" } as NodeJS.ProcessEnv);
    both.attachVault(vault);
    expect(both.get("openai")).toBe("sk-proj-env-0123456789");
    expect(both.sourceOf("openai")).toEqual({ source: "env", env: "OPENAI_API_KEY" });
  });

  it("allows one API key per harness name", async () => {
    const vault = await vaultWith({ openai: "sk-proj-vault-0123456789" });
    expect(() => vault.add({ label: "Second", kind: "apikey", values: { token: "sk-proj-other-0123456789" }, use: { harness: "openai" } })).toThrow(/already KOS's openai key/);
    expect(() => vault.add({ label: "Login", kind: "login", values: { password: "pw-login-0123" }, use: { harness: "anthropic" } })).toThrow(/only an API key/);
    expect(() => vault.add({ label: "Bad", kind: "apikey", values: { token: "x" }, use: { harness: "Open AI" } })).toThrow(/harness is a name/);
  });

  it("is read lazily: a model route picks up a key from a vault opened after boot, with no restart", async () => {
    await vaultWith({ openai: "sk-proj-after-unlock-0123" }, PASS);
    const vault = new Vault({ dir: join(root, "secrets") });
    const secrets = new SecretsRegistry();
    secrets.attachVault(vault);
    const seen: { provider: string; apiKey: string }[] = [];
    const provider = (name: string): Provider => ({
      name,
      keyName: name,
      generate: async (_req: GenerateRequest, spec: ModelSpec, apiKey: string): Promise<ModelResponse> => {
        seen.push({ provider: name, apiKey });
        return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: spec.model };
      },
    });
    const router = new ModelRouter([provider("anthropic"), provider("openai")], () => routingForSecrets(secrets), secrets);
    expect(router.ready("reasoning")).toBe(false);
    await expect(router.generate("reasoning", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).rejects.toThrow(/secret not found/);
    await vault.unlock(PASS);
    expect(router.routeFor("reasoning").provider).toBe("openai");
    expect(router.ready("reasoning")).toBe(true);
    await router.generate("reasoning", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(seen).toEqual([{ provider: "openai", apiKey: "sk-proj-after-unlock-0123" }]);
  }, 20_000);

  it("keeps what the owner chose over the defaults the keys pick", async () => {
    const secrets = new SecretsRegistry({ openai: "sk-o" });
    const none: Provider = { name: "anthropic", keyName: "anthropic", generate: async () => ({ content: [], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "m" }) };
    const router = new ModelRouter([none, { ...none, name: "openai", keyName: "openai" }], () => routingForSecrets(secrets), secrets);
    expect(router.routeFor("cheap").provider).toBe("openai");
    router.setRoute("cheap", { provider: "anthropic", spec: { model: "chosen" } });
    expect(router.routeFor("cheap").spec.model).toBe("chosen");
    expect(router.routeFor("reasoning").provider).toBe("openai");
    router.setRoute("screen", { provider: "openai", spec: { model: "screen" } });
    router.followReasoning();
    expect(router.routeFor("screen")).toEqual(router.routeFor("reasoning"));
  });
});
