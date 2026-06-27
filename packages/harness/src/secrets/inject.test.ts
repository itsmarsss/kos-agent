import { describe, expect, it } from "vitest";

import { SecretsRegistry } from "./secrets.js";
import { hasSecretRef, injectSecrets, injectSecretsInString } from "./inject.js";

describe("secret injection", () => {
  const secrets = new SecretsRegistry({ openai: "sk-real", stripe: "sk-stripe" });

  it("substitutes a reference in a string", () => {
    expect(injectSecretsInString("Bearer {{secret:openai}}", secrets)).toBe(
      "Bearer sk-real",
    );
  });

  it("injects references throughout a nested args object", () => {
    const args = {
      url: "https://api.example.com",
      headers: { authorization: "Bearer {{secret:openai}}" },
      keys: ["{{secret:stripe}}", "plain"],
    };
    expect(injectSecrets(args, secrets)).toEqual({
      url: "https://api.example.com",
      headers: { authorization: "Bearer sk-real" },
      keys: ["sk-stripe", "plain"],
    });
  });

  it("leaves non-string primitives untouched", () => {
    expect(injectSecrets({ n: 5, ok: true, nil: null }, secrets)).toEqual({
      n: 5,
      ok: true,
      nil: null,
    });
  });

  it("throws on an unknown secret name", () => {
    expect(() => injectSecretsInString("{{secret:ghost}}", secrets)).toThrow(
      /secret not found/,
    );
  });

  it("detects whether a value carries a reference", () => {
    expect(hasSecretRef({ a: "{{secret:openai}}" })).toBe(true);
    expect(hasSecretRef({ a: "plain", b: [1, "x"] })).toBe(false);
  });
});
