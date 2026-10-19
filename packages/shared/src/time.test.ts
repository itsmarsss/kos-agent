import { describe, expect, it } from "vitest";

import { formatTime, instantOf, relativeWords, timesInWords, withUnixTimes } from "./time.js";

const TZ = "America/Toronto";
/** 2026-10-18 23:42 in Toronto (EDT, UTC-4) is 03:42 UTC the next day. */
const LATE = Date.UTC(2026, 9, 19, 3, 42) / 1000;

describe("a time token", () => {
  it("reads unix seconds as they are, and a time as written in the owner's zone", () => {
    expect(instantOf("1760845320")).toBe(1760845320);
    expect(instantOf("2026-10-18T23:42", TZ)).toBe(LATE);
    expect(instantOf("2026-10-18 23:42:00", TZ)).toBe(LATE);
    // An offset or Z in the token wins over the zone.
    expect(instantOf("2026-10-19T03:42Z", TZ)).toBe(LATE);
    expect(instantOf("2026-10-18T23:42-04:00", "UTC")).toBe(LATE);
    expect(instantOf("2026-10-19T05:42+0200", "UTC")).toBe(LATE);
    // A date alone is its midnight in the zone.
    expect(instantOf("2026-10-18", TZ)).toBe(Date.UTC(2026, 9, 18, 4) / 1000);
    // Winter: the zone is on standard time, five hours behind.
    expect(instantOf("2026-01-10T09:00", TZ)).toBe(Date.UTC(2026, 0, 10, 14) / 1000);
    expect(instantOf("2026-13-01", TZ)).toBeUndefined();
    expect(instantOf("soon", TZ)).toBeUndefined();
  });

  it("shows each style on the zone's clock", () => {
    expect(formatTime(LATE, "t", TZ)).toBe("23:42");
    expect(formatTime(LATE, "T", TZ)).toBe("23:42:00");
    expect(formatTime(LATE, "d", TZ)).toBe("18/10/2026");
    expect(formatTime(LATE, "D", TZ)).toBe("18 October 2026");
    expect(formatTime(LATE, "f", TZ)).toBe("18 October 2026 23:42");
    expect(formatTime(LATE, undefined, TZ)).toBe("18 October 2026 23:42");
    expect(formatTime(LATE, "F", TZ)).toBe("Sunday 18 October 2026 23:42");
    expect(formatTime(LATE, "t", "UTC")).toBe("03:42");
  });

  it("says how far off a moment is in words", () => {
    const now = LATE * 1000;
    expect(relativeWords(LATE + 10, now)).toBe("in a moment");
    expect(relativeWords(LATE - 10, now)).toBe("just now");
    expect(relativeWords(LATE + 3 * 3600, now)).toBe("in 3 hours");
    expect(relativeWords(LATE + 3600, now)).toBe("in an hour");
    expect(relativeWords(LATE - 2 * 86400, now)).toBe("2 days ago");
    expect(relativeWords(LATE + 90, now)).toBe("in 2 minutes");
    expect(relativeWords(LATE - 40 * 86400, now)).toBe("a month ago");
    expect(relativeWords(LATE + 2 * 31_536_000, now)).toBe("in 2 years");
    expect(formatTime(LATE + 3600, "R", TZ, now)).toBe("in an hour");
  });

  it("fills the seconds in for Discord and leaves what does not parse alone", () => {
    expect(withUnixTimes("at <t:2026-10-18T23:42:R>, then <t:2026-10-19:D>", TZ)).toBe(`at <t:${LATE}:R>, then <t:${Date.UTC(2026, 9, 19, 4) / 1000}:D>`);
    // Already seconds: kept; no style: the default made explicit.
    expect(withUnixTimes("<t:1760845320> and <t:1760845320:t>", TZ)).toBe("<t:1760845320:f> and <t:1760845320:t>");
    expect(withUnixTimes("<t:never:R> and <t:2026-99-99>", TZ)).toBe("<t:never:R> and <t:2026-99-99>");
  });

  it("says the same tokens in words for a surface that renders nothing", () => {
    const now = LATE * 1000;
    expect(timesInWords("due <t:2026-10-19T02:42:R>, on <t:2026-10-19T02:42:f>", TZ, now)).toBe("due in 3 hours, on 19 October 2026 02:42");
    expect(timesInWords("<t:never:R>", TZ, now)).toBe("<t:never:R>");
  });
});
