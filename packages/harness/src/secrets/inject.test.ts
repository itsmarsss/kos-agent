import { describe, expect, it } from "vitest";

import { HTTP_SECRET_SLOTS as SLOTS } from "../tools/http.js";
import { SecretsRegistry } from "./secrets.js";
import { hasSecretRef, placeSecrets, secretsNamed } from "./inject.js";

describe("secret placement", () => {
  const secrets = new SecretsRegistry(
    { openai: "sk-real", stripe: "sk+stripe/1", loose: "unbound-key", pin: "1234" },
    { openai: { hosts: ["api.example.com"] }, stripe: { hosts: ["api.stripe.com", "*.stripe.net"] }, pin: { hosts: ["api.example.com"] } },
  );

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
    // Bound nowhere, a secret is sent nowhere.
    expect(placeSecrets("http.fetch", { url: "https://anywhere.example", headers: { a: "{{secret:loose}}" } }, SLOTS, secrets)).toEqual({
      refused: expect.stringMatching(/loose is bound to no host.*KOS_SECRET_LOOSE_HOSTS/),
    });
  });

  it("refuses a secret too short for the scrubber to find again", () => {
    expect(placeSecrets("http.fetch", { url: "https://api.example.com", headers: { a: "{{secret:pin}}" } }, SLOTS, secrets)).toEqual({
      refused: expect.stringMatching(/pin is shorter than 6 characters/),
    });
  });

  it("names the secrets a call uses, each once", () => {
    expect(secretsNamed({ a: "{{secret:x}} {{secret:y}}", b: ["{{secret:x}}"] })).toEqual(["x", "y"]);
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
