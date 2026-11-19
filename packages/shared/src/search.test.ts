import { describe, expect, it } from "vitest";

import { marksOfLetters, matchText, oneLine, queryWords, snippetOf } from "./search.js";

const marked = (text: string, marks: [number, number][]): string[] => marks.map(([s, e]) => text.slice(s, e));

describe("matchText", () => {
  it("finds the whole query in any case, marking each place", () => {
    const text = "Seed the Tomatoes, then water the tomatoes";
    const m = matchText(text, "tomatoes");
    expect(m?.quality).toBe("phrase");
    expect(marked(text, m!.marks)).toEqual(["Tomatoes", "tomatoes"]);
  });

  it("takes every word when the phrase is not there, and nothing when one is missing", () => {
    const text = "the garden plan for spring";
    expect(matchText(text, "garden plan")?.quality).toBe("phrase");
    const words = matchText(text, "spring garden");
    expect(words?.quality).toBe("words");
    expect(marked(text, words!.marks)).toEqual(["garden", "spring"]);
    expect(matchText(text, "spring winter")).toBeUndefined();
    expect(matchText(text, "   ")).toBeUndefined();
  });

  it("reads a query's punctuation as itself, not as a pattern", () => {
    expect(matchText("costs (est.) $40", "(est.)")?.marks).toEqual([[6, 12]]);
    expect(matchText("abc", ".*")).toBeUndefined();
  });

  it("keeps offsets in the text's own letters where lowering would change their length", () => {
    const text = "İstanbul trip";
    const m = matchText(text, "trip");
    expect(marked(text, m!.marks)).toEqual(["trip"]);
  });
});

describe("snippetOf", () => {
  it("leaves a short text whole", () => {
    expect(snippetOf("water at six", [[0, 5]])).toEqual({ text: "water at six", marks: [[0, 5]] });
  });

  it("cuts a long text around the first match, at a space, and moves the marks", () => {
    const text = `${"lorem ipsum ".repeat(20)}the tomato beds need water ${"dolor sit ".repeat(20)}`;
    const at = text.indexOf("tomato");
    const s = snippetOf(text, [[at, at + 6]], 80);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(82);
    expect(marked(s.text, s.marks)).toEqual(["tomato"]);
    // Not a word cut in half at the start.
    expect(s.text.slice(1, 2)).not.toBe(" ");
    expect(/^…(lorem|ipsum) /.test(s.text)).toBe(true);
  });

  it("drops marks the window does not reach", () => {
    const text = `${"a".repeat(300)}`;
    const s = snippetOf(text, [[10, 12], [290, 295]], 50);
    expect(s.marks).toEqual([[10, 12]]);
  });
});

describe("the small helpers", () => {
  it("splits and dedupes the words of a query", () => {
    expect(queryWords("  Plan  plan the ")).toEqual(["plan", "the"]);
  });
  it("puts text on one line", () => {
    expect(oneLine("a\n\n b\tc ")).toBe("a b c");
  });
  it("joins letters into runs", () => {
    expect(marksOfLetters([0, 1, 2, 5, 7, 8])).toEqual([[0, 3], [5, 6], [7, 9]]);
  });
});
