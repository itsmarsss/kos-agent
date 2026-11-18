import { describe, expect, it } from "vitest";

import { blocksIn, fenceAt, parseBlock, replaceBlocks, valueOf, valuesOf } from "./blocks.js";

const lines = (text: string): string[] => text.split("\n");

describe("parseBlock", () => {
  it("reads the header, the rule and the body", () => {
    const block = parseBlock("kos:email", lines("to: sam@example.com\nsubject: Saturday at 4\n---\nHi Sam,\n\nStill on?"));
    expect(block).toEqual({
      kind: "email",
      fields: [["to", "sam@example.com"], ["subject", "Saturday at 4"]],
      body: "Hi Sam,\n\nStill on?",
    });
  });

  it("keeps a repeated key as a list, in order, and folds a key's case", () => {
    const block = parseBlock("kos:email", lines("to: a@x.com\nTo: b@x.com\ncc:\n---\nhi"));
    expect(block && valuesOf(block, "to")).toEqual(["a@x.com", "b@x.com"]);
    // An empty value is no value.
    expect(block && valuesOf(block, "cc")).toEqual([]);
    expect(block && valueOf(block, "subject")).toBeUndefined();
  });

  it("takes either half empty", () => {
    expect(parseBlock("kos:command", lines("---\nls -la"))).toEqual({ kind: "command", fields: [], body: "ls -la" });
    expect(parseBlock("kos:contact", lines("name: Sam\nphone: 555"))).toEqual({ kind: "contact", fields: [["name", "Sam"], ["phone", "555"]], body: "" });
    expect(parseBlock("kos:card", [])).toEqual({ kind: "card", fields: [], body: "" });
  });

  it("keeps the body verbatim past its first rule, blank ends aside", () => {
    const block = parseBlock("kos:diff", lines("file: a.ts\n---\n\n--- a/a.ts\n+++ b/a.ts\n  key: value\n---\n"));
    expect(block?.body).toBe("--- a/a.ts\n+++ b/a.ts\n  key: value\n---");
  });

  it("is malformed when a header line is not key: value, or the info is not kos:<kind>", () => {
    expect(parseBlock("kos:email", lines("Hi Sam,\nsee you"))).toBeNull();
    expect(parseBlock("kos:email", lines("to sam\n---\nhi"))).toBeNull();
    expect(parseBlock("ts", lines("const a = 1"))).toBeNull();
    expect(parseBlock("kos:", lines("---\nx"))).toBeNull();
    expect(parseBlock("kos:9lives", lines("---\nx"))).toBeNull();
  });

  it("names an unknown kind as written, for the renderer to draw as a card", () => {
    expect(parseBlock("kos:Recipe", lines("title: Soup\n---\nboil"))?.kind).toBe("recipe");
  });
});

describe("fenceAt", () => {
  it("closes only on a run at least as long as the opener, so a block holds a fence", () => {
    const text = lines("````kos:card\ntitle: Snippet\n---\n```ts\nconst a = 1;\n```\n````\nafter");
    const fence = fenceAt(text, 0);
    expect(fence).toMatchObject({ ticks: 4, info: "kos:card", next: 7, closed: true });
    expect(fence?.body).toEqual(["title: Snippet", "---", "```ts", "const a = 1;", "```"]);
  });

  it("runs to the end when nothing closes it, as a reply still arriving", () => {
    expect(fenceAt(lines("```kos:email\nto: a@x.com"), 0)).toMatchObject({ next: 2, closed: false });
  });

  it("opens only on a line of backticks and an info word", () => {
    expect(fenceAt(lines("say ```this```"), 0)).toBeNull();
    expect(fenceAt(lines("``not``"), 0)).toBeNull();
  });
});

describe("blocksIn and replaceBlocks", () => {
  const reply = "Here is the draft.\n\n```kos:message\nto: Sam\nchannel: imessage\n---\nRunning late!\n```\n\n```ts\nx\n```\n```kos:email\nnot a header\n```";

  it("finds the well-formed blocks, past plain code and malformed ones", () => {
    expect(blocksIn(reply).map((b) => b.kind)).toEqual(["message"]);
  });

  it("replaces only well-formed blocks, every other line kept", () => {
    const out = replaceBlocks(reply, (b) => `[${b.kind}: ${b.body}]`);
    expect(out).toBe("Here is the draft.\n\n[message: Running late!]\n\n```ts\nx\n```\n```kos:email\nnot a header\n```");
  });
});
