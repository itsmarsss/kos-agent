import { describe, expect, it } from "vitest";

import type { AuditRecord, RunRecord } from "./api.js";
import { dayLabel, merge } from "./HistoryPage.js";

const DAY = 86_400_000;

function tool(id: number, at: number): AuditRecord {
  return {
    id,
    tool: "files.write",
    args: "{}",
    result: "",
    isError: false,
    createdAt: at,
  };
}

function run(id: number, at: number): RunRecord {
  return {
    id,
    kind: "cron",
    ref: "1",
    status: "ok",
    error: null,
    startedAt: at,
    finishedAt: at + 10,
    durationMs: 10,
  };
}

describe("merging the two histories", () => {
  it("interleaves tools and runs by time, newest first", () => {
    const now = Date.now();
    const rows = merge(
      [tool(1, now - 3000), tool(2, now - 1000)],
      [run(9, now - 2000)],
    );
    // Two pages meant reading both and merging them by eye to find out what
    // happened in what order.
    expect(rows.map((r) => (r.kind === "tool" ? `t${r.tool.id}` : `r${r.run.id}`)))
      .toEqual(["t2", "r9", "t1"]);
  });

  it("marks failures from either side", () => {
    const now = Date.now();
    const rows = merge(
      [{ ...tool(1, now), isError: true }],
      [{ ...run(2, now), status: "error", error: "boom" }],
    );
    expect(rows.every((r) => r.failed)).toBe(true);
  });

  it("copes with one side being empty", () => {
    expect(merge([], [run(1, Date.now())])).toHaveLength(1);
    expect(merge([tool(1, Date.now())], [])).toHaveLength(1);
    expect(merge([], [])).toEqual([]);
  });
});

describe("day labels", () => {
  const noon = new Date(2026, 8, 1, 12, 0, 0).getTime();

  it("names the recent days rather than dating them", () => {
    expect(dayLabel(noon, noon)).toBe("Today");
    expect(dayLabel(noon - DAY, noon)).toBe("Yesterday");
  });

  it("uses the weekday within the week, then a date", () => {
    // Anything a week back would repeat a weekday name, and "Tuesday" that
    // could mean either of two Tuesdays is worse than a date.
    expect(dayLabel(noon - 3 * DAY, noon)).toMatch(/day$/);
    expect(dayLabel(noon - 30 * DAY, noon)).toMatch(/\d/);
  });

  it("counts calendar days, not elapsed hours", () => {
    // 1am today and 11pm yesterday are two hours apart and two different days.
    const oneAm = new Date(2026, 8, 1, 1, 0, 0).getTime();
    const elevenPmYesterday = new Date(2026, 7, 31, 23, 0, 0).getTime();
    expect(dayLabel(oneAm, oneAm)).toBe("Today");
    expect(dayLabel(elevenPmYesterday, oneAm)).toBe("Yesterday");
  });
});
