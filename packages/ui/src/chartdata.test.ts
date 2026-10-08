import { describe, expect, it } from "vitest";

import { clip, hourLabel, padHours } from "./chartdata.js";

/**
 * The hourly query returns only the hours that had a call. A day with two
 * busy hours must draw as a day with two busy hours, not as two bars.
 */
describe("padding the hours", () => {
  const HOUR = 3_600_000;
  const now = 50 * HOUR + 1234;

  it("gives every hour of the window, ending with the hour that is now", () => {
    const hours = padHours([], 24, now);
    expect(hours).toHaveLength(24);
    expect(hours[23]?.hour).toBe(50 * HOUR);
    expect(hours[0]?.hour).toBe(27 * HOUR);
    expect(hours.every((h) => h.calls === 0 && h.errors === 0)).toBe(true);
  });

  it("keeps the counts of the hours that had something", () => {
    const hours = padHours([{ hour: 49 * HOUR, calls: 3, errors: 1 }], 4, now);
    expect(hours.map((h) => h.calls)).toEqual([0, 0, 3, 0]);
    expect(hours[2]?.errors).toBe(1);
  });

  it("drops an hour outside the window rather than stretching to it", () => {
    const hours = padHours([{ hour: 10 * HOUR, calls: 9, errors: 0 }], 4, now);
    expect(hours.every((h) => h.calls === 0)).toBe(true);
  });
});

describe("labels", () => {
  it("says the hour the way a clock does", () => {
    expect(hourLabel(new Date(2026, 0, 1, 0).getTime())).toBe("12am");
    expect(hourLabel(new Date(2026, 0, 1, 15).getTime())).toBe("3pm");
    expect(hourLabel(new Date(2026, 0, 1, 12).getTime())).toBe("12pm");
  });

  it("clips a name that would not fit a node", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("a rather long project name", 10)).toBe("a rather…");
  });
});
