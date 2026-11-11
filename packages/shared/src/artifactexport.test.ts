import { describe, expect, it } from "vitest";

import { exportName } from "./artifactexport.js";

describe("an export's file name", () => {
  it("drops what no disk takes, collapses spaces, and names an empty title", () => {
    expect(exportName(' Q4: plan / "draft"? ', "pdf")).toBe("Q4 plan draft.pdf");
    expect(exportName("...hidden", "md")).toBe("hidden.md");
    expect(exportName(" \u0000 ", "csv")).toBe("artifact.csv");
  });

  it("cuts a long title by characters, never inside an emoji, so the name still encodes", () => {
    const title = `${"a".repeat(99)}\u{1F33F}\u{1F33F}`;
    const name = exportName(title, "html");
    expect(name).toBe(`${"a".repeat(99)}\u{1F33F}.html`);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });
});
