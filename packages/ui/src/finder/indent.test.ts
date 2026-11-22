import { describe, expect, it } from "vitest";

import { DEEP_STEP, FULL_LEVELS, indentUnits, keptChars, levelStyle, treeStyle } from "./indent.js";

const row = (name: string, depth: number, kind: "file" | "dir" = "file") => ({ depth, entry: { name, kind } });

describe("a folder opened in place, stepped in", () => {
  it("steps a whole indent for each of the first levels and less for each past them", () => {
    expect([0, 1, 2, 3].map(indentUnits)).toEqual([0, 1, 2, 3]);
    expect(indentUnits(4)).toBeCloseTo(FULL_LEVELS + DEEP_STEP);
    expect(indentUnits(6)).toBeCloseTo(FULL_LEVELS + 3 * DEEP_STEP);
    for (let d = 1; d < 12; d++) expect(indentUnits(d)).toBeGreaterThan(indentUnits(d - 1));
  });

  it("keeps eight characters of a long name in sight, with its ellipsis and extension, and all of a short one", () => {
    expect(keptChars("Tax_Return_2025_Final_Draft.md", true)).toBe(8 + 1 + 3);
    expect(keptChars("Quarterly_Reports_2025", false)).toBe(9);
    expect(keptChars("a.md", true)).toBe(4);
  });

  it("bounds the list's step by its deepest row and the widest name an indented row keeps", () => {
    const tree = [row("Taxes", 0, "dir"), row("a-top-level-file-with-a-long-name.json", 0), row("2025", 1, "dir"), row("Receipts_for_the_year", 2, "dir"), row("Final_Draft_Signed_Copy.md", 6)];
    expect(treeStyle(tree)).toEqual({ "--finder-units": indentUnits(6), "--finder-keep": "12ch" });
    expect(treeStyle([row("a.md", 0), row("b", 0, "dir")])).toEqual({});
    expect(levelStyle(5)).toEqual({ "--finder-level": indentUnits(5) });
  });
});
