import { describe, expect, it, vi } from "vitest";

import { needlesOf, Scrubber, scrubDeep, STREAM_REACH } from "./scrub.js";
import { SecretsRegistry } from "./secrets.js";

/** A made-up key with characters every encoding treats differently. */
const KEY = "tok_Zq9+/x=\"y&z é";

/** Base64 of `value` sitting at byte offset `pad` inside a longer blob. */
const embedded64 = (value: string, pad: number, url = false): string =>
  Buffer.concat([Buffer.from("x".repeat(pad)), Buffer.from(value), Buffer.from("tail")]).toString(url ? "base64url" : "base64");

describe("Scrubber", () => {
  const scrubber = new Scrubber([["stripe", KEY]]);

  it("takes a value out as it is", () => {
    expect(scrubber.scrub(`key=${KEY}; done`)).toBe("key=[secret stripe]; done");
  });

  it.each([
    ["JSON-escaped", JSON.stringify({ key: KEY })],
    ["URI-encoded", `https://x.example/?k=${encodeURIComponent(KEY)}`],
    ["form-encoded", new URLSearchParams({ k: KEY, other: "1" }).toString()],
    ["base64 at offset 0", embedded64(KEY, 0)],
    ["base64 at offset 1", embedded64(KEY, 1)],
    ["base64 at offset 2", embedded64(KEY, 2)],
    ["base64url at offset 0", embedded64(KEY, 0, true)],
    ["base64url at offset 1", embedded64(KEY, 1, true)],
    ["base64url at offset 2", embedded64(KEY, 2, true)],
    ["percent-encoded in lowercase hex", encodeURIComponent(KEY).replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())],
    ["JSON with escaped slashes", JSON.stringify(KEY).replaceAll("/", "\\/")],
    ["hex", Buffer.from(KEY).toString("hex")],
    ["upper hex", Buffer.from(KEY).toString("hex").toUpperCase()],
  ])("catches it %s", (_form, text) => {
    const out = scrubber.scrub(`before ${text} after`);
    expect(out).toContain("[secret stripe]");
    for (const needle of needlesOf(KEY)) expect(out).not.toContain(needle);
  });

  it("leaves short values and ordinary text alone", () => {
    const short = new Scrubber([["pin", "12345"]]);
    expect(short.scrub("the pin is 12345")).toBe("the pin is 12345");
    expect(scrubber.scrub("nothing to see here")).toBe("nothing to see here");
  });

  it("prefers the longest of overlapping values, leftmost first", () => {
    const both = new Scrubber([["short", "abcdef"], ["long", "abcdefgh"]]);
    expect(both.scrub("xx abcdefgh abcdef")).toBe("xx [secret long] [secret short]");
  });

  it("catches a value with sub-delims percent-encoded as RFC 3986 strictly writes them", () => {
    const strict = (v: string): string => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    expect(new Scrubber([["k", "key!'()*value"]]).scrub(`?k=${strict("key!'()*value")}`)).toBe("?k=[secret k]");
  });

  it("takes out the whole of two values that overlap", () => {
    const both = new Scrubber([["a", "abcdef"], ["b", "defghi"]]);
    expect(both.scrub("xx abcdefghi yy")).toBe("xx [secret a] yy");
  });

  it("holds back one less than its longest needle, an encoding counted only up to the stream's reach", () => {
    expect(new Scrubber([["a", "abcdef"]]).holdBack).toBe(Buffer.from("abcdef").toString("hex").length - 1);
    expect(new Scrubber([]).holdBack).toBe(0);
    // A long value's hex would hold back twice its length; only the value itself counts past the reach.
    expect(new Scrubber([["k", "k".repeat(200)]]).holdBack).toBe(STREAM_REACH - 1);
    expect(new Scrubber([["pem", "p".repeat(400)]]).holdBack).toBe(399);
  });

  it("counts what it took, by name", () => {
    const hit = vi.fn();
    new Scrubber([["a", "secret-one"]], hit).scrub("secret-one and secret-one");
    expect(hit).toHaveBeenCalledWith("a", 2);
  });

  it("scrubs every string in a value, and keeps one with nothing in it", () => {
    const input = { headers: { auth: `Bearer ${KEY}` }, list: ["ok", KEY], n: 1 };
    expect(scrubDeep(input, (t) => scrubber.scrub(t))).toEqual({ headers: { auth: "Bearer [secret stripe]" }, list: ["ok", "[secret stripe]"], n: 1 });
    const clean = { a: ["x"], b: 2 };
    expect(scrubDeep(clean, (t) => scrubber.scrub(t))).toBe(clean);
  });
});

describe("SecretsRegistry.scrub", () => {
  it("looks for today's values after a change, and counts every hit without logging a value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secrets = new SecretsRegistry({ openai: "sk-old-value" });
    expect(secrets.scrub("sk-old-value")).toBe("[secret openai]");
    secrets.set("openai", "sk-new-value");
    expect(secrets.scrub("sk-old-value sk-new-value")).toBe("sk-old-value [secret openai]");
    secrets.adopt(new SecretsRegistry({ cohere: "co-fresh-key" }));
    expect(secrets.scrub("sk-new-value co-fresh-key")).toBe("sk-new-value [secret cohere]");
    expect(secrets.scrubbed()).toBe(3);
    expect(warn).toHaveBeenCalledTimes(3);
    for (const [line] of warn.mock.calls) expect(String(line)).not.toMatch(/sk-|co-fresh/);
    warn.mockRestore();
  });
});

describe("Scrubber digits mode", () => {
  const scrubber = new Scrubber([["visa-personal-7k2q.number", "4242424242424242", "digits"]]);

  it.each([
    ["plain", "4242424242424242"],
    ["spaced", "4242 4242 4242 4242"],
    ["dashed", "4242-4242-4242-4242"],
    ["dotted", "4242.4242.4242.4242"],
    ["with no-break spaces", "4242\u00a04242\u00a04242\u00a04242"],
    ["URL-encoded", "4242%204242%204242%204242"],
  ])("takes a card number out %s and keeps its last four", (_how, written) => {
    expect(scrubber.scrub(`card ${written} on file`)).toBe("card [secret visa-personal-7k2q.number ••4242] on file");
  });

  it("leaves a longer number that only holds it alone", () => {
    expect(scrubber.scrub("id 942424242424242424")).toBe("id 942424242424242424");
  });

  it("counts what it found", () => {
    expect([...scrubber.found("a 4242424242424242 b 4242 4242 4242 4242").hits]).toEqual([["visa-personal-7k2q.number", 2]]);
  });
});
