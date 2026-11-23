import { describe, expect, it } from "vitest";

import { errorWords } from "./errorwords.js";

const enoent = "files.read: ENOENT: no such file or directory, open '/Users/a/ws/blobs/recap/notes/todo.md'";

describe("an error in words", () => {
  it("names a missing file from the workspace down, so where it looked is plain", () => {
    expect(errorWords(enoent, { root: "/Users/a/ws" })).toBe("There is no file or folder at “blobs/recap/notes/todo.md”.");
    expect(errorWords(enoent, { root: "/Users/a/ws/" })).toBe("There is no file or folder at “blobs/recap/notes/todo.md”.");
  });

  it("names it by its last part without the workspace, or outside it", () => {
    expect(errorWords(enoent)).toBe("There is no file or folder called “todo.md”.");
    expect(errorWords(enoent, { root: "/elsewhere" })).toBe("There is no file or folder called “todo.md”.");
  });
});
