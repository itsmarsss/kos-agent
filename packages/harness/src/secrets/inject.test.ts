import { describe, expect, it } from "vitest";

import { SecretsRegistry } from "./secrets.js";
import { hasSecretRef, placeSecrets, type SecretSlots } from "./inject.js";

const SLOTS: SecretSlots = {
  paths: ["headers.*", "url"],
  urls: ["url"],
  host: (input) => (typeof input["url"] === "string" ? new URL(input["url"]).hostname : undefined),
};

describe("secret placement", () => {
  const secrets = new SecretsRegistry({ openai: "sk-real", stripe: "sk+stripe/1" }, { stripe: ["api.stripe.com", "*.stripe.net"] });

  it("expands a reference in a declared slot", () => {
    const placed = placeSecrets("http.fetch", { url: "https://api.example.com", headers: { authorization: "Bearer {{secret:openai}}" } }, SLOTS, secrets);
    expect(placed).toEqual({ input: { url: "https://api.example.com", headers: { authorization: "Bearer sk-real" } } });
  });

  it("expands a URL reference only in its query string, encoded", () => {
    const query = placeSecrets("http.fetch", { url: "https://api.stripe.com/v1?key={{secret:stripe}}#top" }, SLOTS, secrets);
    expect(query).toEqual({ input: { url: "https://api.stripe.com/v1?key=sk%2Bstripe%2F1#top" } });
    for (const url of ["https://{{secret:openai}}.example.com/", "https://api.example.com/{{secret:openai}}", "https://api.example.com/#{{secret:openai}}"]) {
      const placed = placeSecrets("http.fetch", { url }, SLOTS, secrets);
      expect(placed).toEqual({ refused: expect.stringMatching(/only in the query string/) });
    }
  });

  it("refuses a reference outside the tool's slots, and never expands it", () => {
    expect(placeSecrets("http.fetch", { url: "https://api.example.com", body: "{{secret:openai}}" }, SLOTS, secrets)).toEqual({
      refused: expect.stringMatching(/http\.fetch takes no secret in body/),
    });
    const notify = placeSecrets("notify", { text: "the key is {{secret:openai}}" }, undefined, secrets);
    expect(notify).toEqual({ refused: expect.stringMatching(/notify takes no secret in text/) });
    expect(JSON.stringify(notify)).not.toContain("sk-real");
  });

  it("sends a bound secret only to its hosts", () => {
    const to = (url: string) => placeSecrets("http.fetch", { url, headers: { "x-key": "{{secret:stripe}}" } }, SLOTS, secrets);
    expect(to("https://api.stripe.com/v1")).toEqual({ input: { url: "https://api.stripe.com/v1", headers: { "x-key": "sk+stripe/1" } } });
    expect(to("https://files.stripe.net/x")).toHaveProperty("input");
    expect(to("https://evil.example/")).toEqual({ refused: expect.stringMatching(/only to api\.stripe\.com, \*\.stripe\.net, not evil\.example/) });
    expect(to("https://stripe.net.evil.example/")).toHaveProperty("refused");
    // Unbound, a secret goes wherever the call is allowed to.
    expect(placeSecrets("http.fetch", { url: "https://anywhere.example", headers: { a: "{{secret:openai}}" } }, SLOTS, secrets)).toHaveProperty("input");
  });

  it("refuses an unknown secret by name", () => {
    expect(placeSecrets("http.fetch", { url: "https://a.example", headers: { a: "{{secret:ghost}}" } }, SLOTS, secrets)).toEqual({
      refused: expect.stringMatching(/no secret named ghost/),
    });
  });

  it("hands a call with no reference back as it was", () => {
    const input = { url: "https://a.example", n: 5, nil: null };
    expect(placeSecrets("x", input, undefined, secrets)).toEqual({ input });
  });

  it("detects whether a value carries a reference", () => {
    expect(hasSecretRef({ a: "{{secret:openai}}" })).toBe(true);
    expect(hasSecretRef({ a: "plain", b: [1, "x"] })).toBe(false);
  });
});
