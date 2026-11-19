import { describe, expect, it } from "vitest";

import { carriesText, copyKey, parseKeys } from "./keys.js";

/** The keys and editing commands a page holding a secret refuses: every way a field's text is copied, cut, selected whole or pasted. */
describe("a key that carries text out of a field", () => {
  const of = (combo: string): boolean => {
    const p = parseKeys(combo);
    return copyKey(p.key, p.code, p.keyCode, p.modifiers, p.commands);
  };

  it("is a copy, cut, select-all or paste key, by any of its names", () => {
    for (const combo of ["Meta+a", "Control+c", "Meta+x", "Control+Insert", "Meta+Insert", "Shift+Insert", "Shift+Delete"]) expect(of(combo)).toBe(true);
    expect(copyKey("", "KeyC", 0, 2)).toBe(true);
    expect(copyKey("", "", 67, 4)).toBe(true);
    expect(copyKey("", "", 45, 8)).toBe(true);
    expect(copyKey("Delete", "", 0, 8)).toBe(true);
  });

  it("is an editing command that takes text out, kill-ring deletes and the yank among them", () => {
    for (const c of ["copy", "Cut", "selectAll", "yank", "yankAndSelect", "deleteToEndOfLine", "deleteToEndOfParagraph", "deleteToBeginningOfLine", "deleteWordBackward", "deleteWordForward"]) {
      expect(carriesText(c)).toBe(true);
      expect(copyKey("Enter", "Enter", 13, 0, [c])).toBe(true);
    }
    for (const c of ["paste", "undo", "insertNewline", "deleteBackward", "moveRight"]) expect(carriesText(c)).toBe(false);
  });

  it("is not a plain key, a shifted letter, Delete alone or Insert alone", () => {
    for (const combo of ["a", "Shift+a", "Delete", "Insert", "Enter", "Meta+v", "Control+z", "Alt+c"]) expect(of(combo)).toBe(false);
  });
});
