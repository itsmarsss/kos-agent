import { describe, expect, it } from "vitest";

import { padDays } from "./SpendPanel.js";

/**
 * The daily query groups by day, so it returns only the days that had usage.
 * Two busy days inside a month came back as two bars: a stub in the corner of
 * a wide chart that read as "the last two days" rather than "twice in a
 * month". The gaps are the information.
 */
describe("padding the spend trend", () => {
  const today = new Date(2026, 8, 2);

  it("gives one entry per day of the window", () => {
    expect(padDays([], 30, today)).toHaveLength(30);
    expect(padDays([], 7, today)).toHaveLength(7);
  });

  it("ends on today and runs backwards", () => {
    const week = padDays([], 7, today);
    expect(week[6]!.day).toBe("2026-09-02");
    expect(week[0]!.day).toBe("2026-08-27");
  });

  it("keeps the days that have numbers, in place", () => {
    const rows = [
      { day: "2026-08-31", inputTokens: 13810, outputTokens: 106 },
      { day: "2026-09-01", inputTokens: 427830, outputTokens: 20773 },
    ];
    const week = padDays(rows, 7, today);
    expect(week.find((d) => d.day === "2026-08-31")).toEqual(rows[0]);
    expect(week.find((d) => d.day === "2026-09-01")).toEqual(rows[1]);
    expect(week.find((d) => d.day === "2026-08-30")).toEqual({
      day: "2026-08-30",
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("crosses a month boundary correctly", () => {
    const days = padDays([], 3, new Date(2026, 2, 2));
    // March 2 back through the end of February, which had 28 days in 2026.
    expect(days.map((d) => d.day)).toEqual([
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("does not choke on a day outside the window", () => {
    const stale = [{ day: "2020-01-01", inputTokens: 5, outputTokens: 5 }];
    const week = padDays(stale, 7, today);
    expect(week).toHaveLength(7);
    expect(week.every((d) => d.inputTokens === 0)).toBe(true);
  });
});
