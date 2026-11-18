import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HTTP_SECRET_SLOTS } from "../tools/http.js";
import { placeSecrets } from "./inject.js";
import { SecretsRegistry } from "./secrets.js";
import { Vault } from "./vault.js";

describe("SecretsRegistry", () => {
  it("maps provider env vars to named secrets", () => {
    const reg = SecretsRegistry.fromEnv({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
    } as NodeJS.ProcessEnv);
    expect(reg.get("anthropic")).toBe("sk-ant");
    expect(reg.get("openai")).toBe("sk-oai");
  });

  it("exposes KOS_SECRET_* env vars as lowercased names", () => {
    const reg = SecretsRegistry.fromEnv({
      KOS_SECRET_STRIPE: "sk-stripe",
    } as NodeJS.ProcessEnv);
    expect(reg.get("stripe")).toBe("sk-stripe");
  });

  it("binds a KOS_SECRET_* to hosts by its _HOSTS twin, which is no secret itself", () => {
    const reg = SecretsRegistry.fromEnv({
      KOS_SECRET_STRIPE: "sk-stripe",
      KOS_SECRET_STRIPE_HOSTS: "API.stripe.com, *.stripe.net",
    } as NodeJS.ProcessEnv);
    expect(reg.hostsOf("stripe")).toEqual(["api.stripe.com", "*.stripe.net"]);
    expect(reg.has("stripe_hosts")).toBe(false);
    expect(reg.hostsOf("openai")).toBeUndefined();
  });

  it("binds provider keys to their own APIs, and a secret to MCP servers by its _MCP twin", () => {
    const reg = SecretsRegistry.fromEnv({
      ANTHROPIC_API_KEY: "sk-ant-value",
      OPENAI_API_KEY: "sk-oai-value",
      OPENAI_API_KEY_UNUSED: "",
      KOS_SECRET_NOTION: "ntn-value",
      KOS_SECRET_NOTION_MCP: "Notion, notes",
    } as NodeJS.ProcessEnv);
    expect(reg.hostsOf("anthropic")).toEqual(["api.anthropic.com"]);
    expect(reg.hostsOf("openai")).toEqual(["api.openai.com"]);
    expect(reg.serversOf("notion")).toEqual(["notion", "notes"]);
    expect(reg.has("notion_mcp")).toBe(false);
  });

  it("scrubs the harness's own credentials without offering them as secrets", () => {
    const reg = SecretsRegistry.fromEnv({
      KOS_DASHBOARD_TOKEN: "dash-token-value",
      DISCORD_BOT_TOKEN: "discord-token-value",
      SOME_SERVICE_PASSWORD: "service-password-value",
      DEBUG_KEY: "verbose",
      PATH: "/usr/bin:/bin:/usr/sbin",
    } as NodeJS.ProcessEnv);
    reg.watch("device_host_key", "device-key-value");
    expect(reg.has("kos_dashboard_token")).toBe(false);
    // A short value is a setting, not a credential: "verbose" is left in ordinary text.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(reg.scrub("dash-token-value discord-token-value service-password-value device-key-value /usr/bin:/bin:/usr/sbin")).toBe(
      "[secret kos_dashboard_token] [secret discord_bot_token] [secret some_service_password] [secret device_host_key] /usr/bin:/bin:/usr/sbin",
    );
    expect(reg.scrub("verbose logging is on")).toBe("verbose logging is on");
    reg.adopt(SecretsRegistry.fromEnv({} as NodeJS.ProcessEnv));
    expect(reg.scrub("dash-token-value device-key-value")).toBe("dash-token-value [secret device_host_key]");
    warn.mockRestore();
  });

  it("require throws for a missing secret", () => {
    const reg = new SecretsRegistry();
    expect(() => reg.require("anthropic")).toThrow(/secret not found/);
  });

  it("redacts known secret values by name", () => {
    const reg = new SecretsRegistry({ anthropic: "sk-ant-123" });
    const log = "calling api with key sk-ant-123 now";
    expect(reg.redact(log)).toBe("calling api with key {{secret:anthropic}} now");
  });

  it("does not redact empty values", () => {
    const reg = new SecretsRegistry({ blank: "" });
    expect(reg.redact("unchanged")).toBe("unchanged");
  });
});

describe("SecretsRegistry over a vault", () => {
  let root: string;
  let vault: Vault;
  let reg: SecretsRegistry;
  let key: string;
  let card: string;
  let note: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-registry-vault-"));
    vault = new Vault({ dir: join(root, "secrets") });
    await vault.init();
    key = vault.add({ label: "Stripe", kind: "apikey", values: { token: "sk_live_vaulted_0123456789", username: "acct" }, use: { http: { hosts: ["api.stripe.com"] } } });
    card = vault.add({ label: "Visa personal", kind: "card", values: { number: "4111 1111 1111 1111", cvc: "737" } });
    note = vault.add({ label: "Recovery", kind: "note", values: { text: "first recovery line here\nsecond line of the phrase" } });
    reg = SecretsRegistry.fromEnv({ KOS_SECRET_STRIPE: "sk-env-stripe-value-123" } as NodeJS.ProcessEnv);
    reg.attachVault(vault);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves a handle to its main field and handle.field to any", () => {
    expect(reg.get(key)).toBe("sk_live_vaulted_0123456789");
    expect(reg.get(`${key}.username`)).toBe("acct");
    expect(reg.get(`${card}.number`)).toBe("4111111111111111");
    expect(reg.get(`${key}.password`)).toBeUndefined();
    expect(reg.get("stripe")).toBe("sk-env-stripe-value-123");
    expect(reg.inVault(key)).toBe(true);
    expect(reg.inVault("stripe")).toBe(false);
  });

  it("binds a vault key to its http hosts", () => {
    expect(reg.hostsOf(key)).toEqual(["api.stripe.com"]);
    expect(reg.hostsOf(card)).toBeUndefined();
  });

  it("places a vault key only in a declared slot, to a bound host", () => {
    const ok = placeSecrets("http.fetch", { url: "https://api.stripe.com/v1", headers: { authorization: `Bearer {{secret:${key}}}` } }, HTTP_SECRET_SLOTS, reg);
    expect(ok).toEqual({ input: { url: "https://api.stripe.com/v1", headers: { authorization: "Bearer sk_live_vaulted_0123456789" } } });
    const elsewhere = placeSecrets("http.fetch", { url: "https://evil.example/", headers: { a: `{{secret:${key}}}` } }, HTTP_SECRET_SLOTS, reg);
    expect(elsewhere).toMatchObject({ refused: expect.stringMatching(/only to api.stripe.com/) });
    const unbound = placeSecrets("http.fetch", { url: "https://x.example/", headers: { a: `{{secret:${note}}}` } }, HTTP_SECRET_SLOTS, reg);
    expect(unbound).toMatchObject({ refused: expect.stringMatching(/Secrets page/) });
  });

  it("scrubs every vault value, with its transforms and a card by its digits", () => {
    const text = [
      "token sk_live_vaulted_0123456789",
      `b64 ${Buffer.from("sk_live_vaulted_0123456789").toString("base64")}`,
      "card 4111-1111-1111-1111",
      "line second line of the phrase",
    ].join("\n");
    const out = reg.scrub(text);
    expect(out).toContain(`[secret ${key}.token]`);
    expect(out).toContain(`[secret ${card}.number ••1111]`);
    expect(out).toContain(`[secret ${note}.text]`);
    expect(out).not.toMatch(/sk_live_vaulted|4111-1111|second line of the phrase/);
    expect(reg.scrubbed()).toBeGreaterThanOrEqual(4);
  });

  it("follows the vault: a new value is scrubbed, a removed one is not resolved", () => {
    expect(reg.scrub("pw-brand-new-value!")).toBe("pw-brand-new-value!");
    const login = vault.add({ label: "GitHub", kind: "login", values: { password: "pw-brand-new-value!" } });
    expect(reg.scrub("pw-brand-new-value!")).toBe(`[secret ${login}.password]`);
    vault.remove(login);
    expect(reg.get(login)).toBeUndefined();
  });

  it("names what it masked, for a door to tell the owner", () => {
    expect(reg.mask("my key is sk_live_vaulted_0123456789")).toEqual({ text: `my key is [secret ${key}.token]`, found: [`${key}.token`] });
  });

  it("keeps the vault through a reload of the env", () => {
    reg.adopt(SecretsRegistry.fromEnv({} as NodeJS.ProcessEnv));
    expect(reg.get(key)).toBe("sk_live_vaulted_0123456789");
    expect(reg.get("stripe")).toBeUndefined();
  });
});

describe("SecretsRegistry and a vault changed elsewhere", () => {
  it("scrubs a value another process added, within a poll", async () => {
    const root = mkdtempSync(join(tmpdir(), "kos-registry-poll-"));
    try {
      let now = 0;
      const vault = new Vault({ dir: join(root, "secrets"), now: () => now });
      await vault.init();
      const reg = new SecretsRegistry();
      reg.attachVault(vault);
      expect(reg.scrub("pw-added-by-the-cli")).toBe("pw-added-by-the-cli");
      const handle = new Vault({ dir: join(root, "secrets") }).add({ label: "CLI", kind: "login", values: { password: "pw-added-by-the-cli" } });
      now += 1_000;
      expect(reg.scrub("pw-added-by-the-cli")).toBe(`[secret ${handle}.password]`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
