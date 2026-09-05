import { describe, expect, it } from "vitest";

import { highlights, tokenize, type TokenKind } from "./highlight.js";

/** The kinds, in order, for a source string. */
function kinds(src: string, lang = "typescript"): TokenKind[] {
  return tokenize(src, lang).map((t) => t.kind);
}
/** The text of the first run of a kind. */
function first(src: string, kind: TokenKind, lang = "typescript"): string {
  return tokenize(src, lang).find((t) => t.kind === kind)?.text ?? "";
}

describe("highlighting source", () => {
  it("never loses or reorders a character", () => {
    /*
     * The one property that matters. Colouring is decoration and getting it
     * wrong costs a dull word; dropping a character silently corrupts what
     * the owner is reading.
     */
    for (const [src, lang] of [
      ["const x = 1; // note\nfoo(`a${b}c`)", "typescript"],
      ["def f(x):\n  '''doc'''\n  return x + 1", "python"],
      ['{"a": [1, 2], "b": null}', "json"],
      ["SELECT * FROM t WHERE a = 'b' -- why", "sql"],
      ["/* unterminated", "typescript"],
      ["'unterminated", "python"],
      ["", "typescript"],
      ["émoji 🎉 and ünïcode", "typescript"],
    ] as const) {
      expect(tokenize(src, lang).map((t) => t.text).join(""), src).toBe(src);
    }
  });

  it("finds comments, strings, numbers and keywords", () => {
    expect(first("// a note", "comment")).toBe("// a note");
    expect(first("/* over\ntwo lines */", "comment")).toBe("/* over\ntwo lines */");
    expect(first('"hello"', "string")).toBe('"hello"');
    expect(first("const x = 42", "number")).toBe("42");
    expect(first("const x = 1", "keyword")).toBe("const");
  });

  it("does not let a string run past its line", () => {
    // A stray quote would otherwise colour the rest of the file as a string.
    const out = tokenize("const a = 'oops\nconst b = 2", "typescript");
    expect(out.find((t) => t.kind === "string")?.text).toBe("'oops");
    expect(out.some((t) => t.kind === "keyword" && t.text === "const")).toBe(true);
  });

  it("lets a template literal cross lines, because it does", () => {
    const out = tokenize("const a = `one\ntwo`;", "typescript");
    expect(out.find((t) => t.kind === "string")?.text).toBe("`one\ntwo`");
  });

  it("colours an unterminated comment to the end rather than giving up", () => {
    // A file being edited is unterminated most of the time.
    expect(first("/* still writing", "comment")).toBe("/* still writing");
  });

  it("uses each language's own comment marker", () => {
    expect(first("# a note", "comment", "python")).toBe("# a note");
    expect(first("-- a note", "comment", "sql")).toBe("-- a note");
    expect(first("# a note", "comment", "bash")).toBe("# a note");
    // Not a comment in a C-family language, where it is a private field.
    expect(kinds("#x", "typescript")).not.toContain("comment");
  });

  it("does not colour a keyword that is part of a longer word", () => {
    const out = tokenize("constant = 1", "typescript");
    expect(out.some((t) => t.kind === "keyword")).toBe(false);
  });

  it("leaves prose and data alone", () => {
    expect(highlights("markdown")).toBe(false);
    expect(highlights("csv")).toBe(false);
    expect(highlights("")).toBe(false);
    expect(highlights("typescript")).toBe(true);
  });
});
