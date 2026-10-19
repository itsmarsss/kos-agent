import { describe, expect, it } from "vitest";

import { pathsIn } from "./workspacepath.js";

describe("pathsIn", () => {
  it("picks the workspace paths out of a step, trailing punctuation left outside", () => {
    expect(pathsIn("Read blobs/verity/blob.md.")).toEqual([{ text: "Read " }, { text: "blobs/verity/blob.md", path: "blobs/verity/blob.md" }, { text: "." }]);
    expect(pathsIn("List projects/garden and uploads/a b")).toEqual([
      { text: "List " },
      { text: "projects/garden", path: "projects/garden" },
      { text: " and " },
      { text: "uploads/a", path: "uploads/a" },
      { text: " b" },
    ]);
    // Not a path: a zone, an absolute path, a reference already written, nothing at all.
    expect(pathsIn("timezone=America/Toronto in /w/projects/x")).toEqual([{ text: "timezone=America/Toronto in /w/projects/x" }]);
    expect(pathsIn("see @file:projects/x/a.md")).toEqual([{ text: "see @file:projects/x/a.md" }]);
    expect(pathsIn("")).toEqual([]);
  });
});
