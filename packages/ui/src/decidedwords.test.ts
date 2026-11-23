import { describe, expect, it } from "vitest";

import { decidedWords } from "./decidedwords.js";

describe("what a decision's toast says", () => {
  const plain = { remember: false, kept: false, held: false };
  it("names the ask by what it asked, never its number", () => {
    expect(decidedWords(false, "Fetch the status page", plain)).toBe("Denied: Fetch the status page");
    expect(decidedWords(true, "Run: ls", plain)).toBe("Approved: Run: ls");
  });
  it("says what was remembered, and when the chat still waits", () => {
    expect(decidedWords(true, "Run: ls", { remember: true, kept: true, held: false })).toBe("Approved: Run: ls, and remembered");
    expect(decidedWords(true, "Run: ls", { remember: true, kept: false, held: true })).toBe("Approved: Run: ls; nothing to remember for this one. The chat waits on another ask");
  });
});
