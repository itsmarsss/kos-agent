import { describe, expect, it, vi } from "vitest";

import { SecretsRegistry } from "./secrets.js";

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
      PATH: "/usr/bin:/bin:/usr/sbin",
    } as NodeJS.ProcessEnv);
    reg.watch("device_host_key", "device-key-value");
    expect(reg.has("kos_dashboard_token")).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(reg.scrub("dash-token-value discord-token-value service-password-value device-key-value /usr/bin:/bin:/usr/sbin")).toBe(
      "[secret kos_dashboard_token] [secret discord_bot_token] [secret some_service_password] [secret device_host_key] /usr/bin:/bin:/usr/sbin",
    );
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
