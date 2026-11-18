import { describe, expect, it } from "vitest";

import { luhn, scrubShapes } from "./shapes.js";

describe("scrubShapes", () => {
  it.each([
    ["spaced", "4111 1111 1111 1111"],
    ["dashed", "4111-1111-1111-1111"],
    ["no-break spaces", "4111 1111 1111 1111"],
    ["URL-encoded spaces", "4111%201111%201111%201111"],
    ["a 15-digit Amex", "378282246310005"],
  ])("masks a Luhn-valid card %s", (_how, card) => {
    expect(scrubShapes(`pay with ${card} today`).text).toMatch(/^pay with \[secret card ••\d{4}\] today$/);
  });

  it("leaves numbers that fail Luhn, are too short, or sit in a longer number", () => {
    for (const text of ["4111 1111 1111 1112", "411111111111", "94111111111111111119999"]) expect(scrubShapes(text).text).toBe(text);
  });

  it.each(["sk-proj0123456789abcdefABCD", "sk_live_abcdefgh12", "sk_test_abcdefgh12", "ghp_0123456789abcdefghij", "gho_0123456789abcdefghij", "github_pat_0123456789abcdefghij_x", "xoxb-1234567890-abc", "AKIAIOSFODNN7EXAMPLE", "AIzaSyA0123456789abcdefghijklmnopqrstuv", "glpat-0123456789abcdefghij"])("masks a key shaped %s", (key) => {
    expect(scrubShapes(`key=${key};`).text).toBe("key=[secret key];");
  });

  it("leaves the prefixes as words", () => {
    for (const text of ["ask-me", "the sk-learn docs", "AKIA alone", "risk_live_x"]) expect(scrubShapes(text).text).toBe(text);
  });

  it("checks Luhn", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
  });
});
