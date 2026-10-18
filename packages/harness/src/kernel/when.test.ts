import { describe, expect, it } from "vitest";

import { clockLine, systemTimezone, whenWords } from "./when.js";

// Sunday 18 October 2026, 18:52 UTC: 14:52 in Toronto, which is on EDT.
const NOW = Date.UTC(2026, 9, 18, 18, 52);
const H = 3_600_000;
const D = 24 * H;

describe("times in the owner's words", () => {
  it("says the moment in full, in the owner's zone", () => {
    expect(clockLine(NOW, "America/Toronto")).toBe("Sunday 18 October 2026, 14:52 (America/Toronto, EDT)");
    expect(clockLine(NOW, "UTC")).toBe("Sunday 18 October 2026, 18:52 (UTC, UTC)");
    expect(clockLine(NOW, "Asia/Tokyo")).toBe("Monday 19 October 2026, 03:52 (Asia/Tokyo, GMT+9)");
  });

  it("counts days on the owner's calendar, not UTC's", () => {
    // 22:00 UTC is still today in Toronto (18:00) and already tomorrow in Tokyo.
    const at = Date.UTC(2026, 9, 18, 22);
    expect(whenWords(at, "America/Toronto", NOW)).toBe("today 18:00");
    expect(whenWords(at, "Asia/Tokyo", NOW)).toBe("today 07:00");
    expect(whenWords(Date.UTC(2026, 9, 19, 11, 30), "America/Toronto", NOW)).toBe("tomorrow 07:30");
    expect(whenWords(NOW - D + H, "America/Toronto", NOW)).toBe("yesterday 15:52");
  });

  it("names the day within a week and the date past it", () => {
    expect(whenWords(NOW + 2 * D, "America/Toronto", NOW)).toBe("Tue 20 Oct 14:52");
    expect(whenWords(NOW - 6 * D, "America/Toronto", NOW)).toBe("Mon 12 Oct 14:52");
    expect(whenWords(NOW + 7 * D, "America/Toronto", NOW)).toBe("25 Oct 2026 14:52");
    expect(whenWords(Date.UTC(2025, 0, 2, 5), "America/Toronto", NOW)).toBe("2 Jan 2025 00:00");
  });

  it("falls back to UTC for a zone the machine does not know, and knows its own", () => {
    expect(whenWords(NOW, "Mars/Olympus", NOW)).toBe("today 18:52");
    expect(() => new Intl.DateTimeFormat("en", { timeZone: systemTimezone() })).not.toThrow();
  });
});
