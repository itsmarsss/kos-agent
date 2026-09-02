import { describe, expect, it } from "vitest";

import { formatCell } from "./format.js";

/**
 * A stored epoch is a number, and a number over ten thousand was compacted, so
 * every generated table with a created_at column showed "1.8T" where a date
 * belonged. Ids fared no better: row 12345 read "12.3K".
 */
describe("formatCell", () => {
  it("reads a timestamp column as a date", () => {
    const out = formatCell(1788262468024, "created_at");
    expect(out).not.toContain("T");
    expect(out).toMatch(/\d/);
    expect(new Date(out).getTime()).not.toBeNaN();
  });

  it("handles epoch seconds as well as milliseconds", () => {
    const ms = formatCell(1788262468024, "updated_at");
    const seconds = formatCell(1788262468, "updated_at");
    expect(seconds).toBe(ms);
  });

  it("leaves an ordinary number in a timestamp-named column alone", () => {
    // "attempts_at_bat" is not a date, and neither is a count of 42.
    expect(formatCell(42, "created_at")).toBe("42");
  });

  it("does not compact an identifier", () => {
    expect(formatCell(12345, "id")).toBe("12345");
    expect(formatCell(98765, "project_id")).toBe("98765");
  });

  it("still compacts an actual measure", () => {
    expect(formatCell(1500000, "revenue")).toBe("1.5M");
  });

  it("is unchanged for everything else", () => {
    expect(formatCell(null)).toBe("");
    expect(formatCell("hello")).toBe("hello");
    expect(formatCell(true)).toBe("yes");
    expect(formatCell(42.5, "amount")).toBe("42.5");
  });

  it("does not guess when it has no column to go on", () => {
    // Called without a column name it cannot know, and inventing a date from
    // magnitude alone would corrupt a genuinely large measure.
    expect(formatCell(1788262468024)).toBe("1.8T");
  });
});
