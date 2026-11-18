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

/** The first number from `start` up that passes Luhn: a timestamp or an id that would look like a card. */
function luhnFrom(start: bigint): string {
  for (let n = start; ; n++) if (luhn(String(n))) return String(n);
}

describe("scrubShapes leaves ordinary data alone", () => {
  const stamp = luhnFrom(1763400000000n);
  const snowflake = luhnFrom(123456789012345678n);
  const sixteen = luhnFrom(4000000000000000n);

  it("keeps a Luhn-valid millisecond timestamp and an 18-digit snowflake", () => {
    for (const text of [`at ${stamp}`, `message ${snowflake}`, `<@${snowflake}>`]) expect(scrubShapes(text).text).toBe(text);
  });

  it("keeps bare JSON timestamps and ids, and turns a card there into a string, so JSON still parses", () => {
    const json = `{"at":${stamp},"id":${snowflake},"n":${sixteen},"list":[${sixteen}]}`;
    const out = scrubShapes(json).text;
    const parsed = JSON.parse(out) as { at: number; id: number; n: string; list: string[] };
    expect(out).toContain(`"at":${stamp}`);
    expect(out).toContain(`"id":${snowflake}`);
    expect(parsed.n).toBe(`[secret card ••${sixteen.slice(-4)}]`);
    expect(parsed.list).toEqual([`[secret card ••${sixteen.slice(-4)}]`]);
  });

  it("keeps an unseparated run inside an id or a longer number", () => {
    for (const text of [`id_${sixteen}`, `x${sixteen}`, `${sixteen}abc`, `9${sixteen}`]) expect(scrubShapes(text).text).toBe(text);
  });

  it("still masks a card standing alone, quoted, or written with new separators", () => {
    expect(scrubShapes(`card ${sixteen}`).text).toBe(`card [secret card ••${sixteen.slice(-4)}]`);
    expect(scrubShapes(JSON.stringify({ card: sixteen }))).toMatchObject({ text: `{"card":"[secret card ••${sixteen.slice(-4)}]"}` });
    for (const sep of ["+", "\t", "_", "/", "%C2%A0", " - "]) {
      const written = sixteen.match(/.{4}/g)!.join(sep);
      expect(scrubShapes(`pay ${written} now`).text).toBe(`pay [secret card ••${sixteen.slice(-4)}] now`);
    }
  });
});

describe("scrubShapes finds a card pasted with more around it", () => {
  it.each([
    ["an expiry after", "4111 1111 1111 1111 12/27", "[secret card ••1111] 12/27"],
    ["a CVV after", "4111111111111111 123", "[secret card ••1111] 123"],
    ["an expiry with no slash after", "4111-1111-1111-1111 0427", "[secret card ••1111] 0427"],
    ["tabs", "4111\t1111\t1111\t1111\t12/27", "[secret card ••1111]\t12/27"],
    ["a numbered list marker", "1. 4111 1111 1111 1111", "1. [secret card ••1111]"],
    ["a hash list marker", "#2 4111 1111 1111 1111", "#2 [secret card ••1111]"],
    ["an expiry before", "exp 12/27 4111 1111 1111 1111", "exp 12/27 [secret card ••1111]"],
  ])("with %s", (_how, text, masked) => {
    expect(scrubShapes(text).text).toBe(masked);
  });
});
