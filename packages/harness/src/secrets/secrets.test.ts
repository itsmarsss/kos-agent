import { describe, expect, it } from "vitest";

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
