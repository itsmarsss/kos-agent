// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { highlightPieces } from "./HighlightedInput.js";

describe("bracketed references", () => {
  it("colours a name with spaces in it as one reference", () => {
    // The composer inserts the bracketed form for ids the plain one cannot
    // carry, and the highlighter used to stop at the first space, colouring
    // half a job name and leaving the rest as prose.
    const pieces = highlightPieces("check @schedule:[9 AM Pinger Test] now");
    expect(pieces.find((p) => p.kind === "schedule")?.text).toBe(
      "@schedule:[9 AM Pinger Test]",
    );
  });

  it("still colours the plain form", () => {
    expect(
      highlightPieces("@project:budget_tracker").find((p) => p.kind === "project")
        ?.text,
    ).toBe("@project:budget_tracker");
  });
});

describe("highlightPieces", () => {
  it("marks a reference and leaves the rest alone", () => {
    expect(highlightPieces("look at @file:a/b.md now")).toEqual([
      { text: "look at " },
      { text: "@file:a/b.md", kind: "file" },
      { text: " now" },
    ]);
  });

  it("keeps every character, so the mirror stays the same length", () => {
    // The mirror sits under the textarea; a dropped character shifts the text
    // out of register with the caret.
    const text = "a @project:x b @page:y c";
    expect(highlightPieces(text).map((p) => p.text).join("")).toBe(text);
  });

  it("marks a leading slash command", () => {
    expect(highlightPieces("/archive")[0]).toEqual({
      text: "/archive",
      kind: "command",
    });
  });

  it("leaves a slash that is not a command", () => {
    expect(highlightPieces("see docs/api")).toEqual([{ text: "see docs/api" }]);
  });

  it("marks a command it has never heard of", () => {
    // The list of real commands lives on the server and drives the menu. This
    // file used to keep a second copy, which is how /compact and /clear ended
    // up being the only commands that were not coloured.
    expect(highlightPieces("/compact")[0]).toEqual({
      text: "/compact",
      kind: "command",
    });
    expect(highlightPieces("/clear")[0]).toEqual({
      text: "/clear",
      kind: "command",
    });
  });

  it("does not take the full stop that ends a sentence", () => {
    const pieces = highlightPieces("check @schedule:kos.backup.");
    expect(pieces[1]).toEqual({ text: "@schedule:kos.backup", kind: "schedule" });
    expect(pieces[2]).toEqual({ text: "." });
  });

  it("handles several references in one line", () => {
    const kinds = highlightPieces("@project:a and @page:b and @file:c.md")
      .filter((p) => p.kind)
      .map((p) => p.kind);
    expect(kinds).toEqual(["project", "page", "file"]);
  });

  it("returns nothing to mark for empty text", () => {
    expect(highlightPieces("")).toEqual([]);
  });
});
