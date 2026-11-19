import { describe, expect, it } from "vitest";

import { clockWords, dayNumber, dayWords, GAP_MS, markWords, momentWords, timeMarks } from "./chattime.js";

const at = (iso: string): number => Date.parse(iso);
const NY = "America/New_York";

describe("the day an instant falls on", () => {
  it("is the reader's day, not UTC's", () => {
    // 03:30 UTC on the 18th is still the 17th in New York.
    expect(dayNumber(at("2026-11-18T03:30:00Z"), NY)).toBe(dayNumber(at("2026-11-17T12:00:00Z"), "UTC"));
    expect(dayNumber(at("2026-11-18T03:30:00Z"), "Asia/Tokyo")).toBe(dayNumber(at("2026-11-18T12:00:00Z"), "UTC"));
  });
});

describe("the lines between a chat's messages", () => {
  it("names the day over the first message, and again where the day changes at midnight", () => {
    const marks = timeMarks([at("2026-11-17T23:58:00-05:00"), at("2026-11-17T23:59:00-05:00"), at("2026-11-18T00:01:00-05:00")], NY);
    expect(marks.map((m) => m?.kind)).toEqual(["day", undefined, "day"]);
  });

  it("puts the time over a message said after a pause of fifteen minutes or more, and not after a shorter one", () => {
    const start = at("2026-11-18T09:00:00-05:00");
    const marks = timeMarks([start, start + GAP_MS - 1, start + 2 * GAP_MS - 2, start + 3 * GAP_MS + 60_000], NY);
    expect(marks.map((m) => m?.kind)).toEqual(["day", undefined, undefined, "gap"]);
    expect(marks[3]).toEqual({ kind: "gap", at: start + 3 * GAP_MS + 60_000 });
  });

  it("counts a pause across a change of the clocks in real time, on the day it is", () => {
    // New York falls back at 02:00 on Nov 1 2026: 01:50 EDT to 01:10 EST is twenty minutes, one day.
    const marks = timeMarks([at("2026-11-01T01:50:00-04:00"), at("2026-11-01T01:10:00-05:00"), at("2026-11-01T01:20:00-05:00")], NY);
    expect(marks.map((m) => m?.kind)).toEqual(["day", "gap", undefined]);
    // And springs forward on Mar 8: 01:55 EST to 03:05 EDT is ten minutes.
    const spring = timeMarks([at("2026-03-08T01:55:00-05:00"), at("2026-03-08T03:05:00-04:00")], NY);
    expect(spring.map((m) => m?.kind)).toEqual(["day", undefined]);
  });

  it("marks the same messages differently for readers in different zones", () => {
    const times = [at("2026-11-18T04:30:00Z"), at("2026-11-18T05:30:00Z")];
    expect(timeMarks(times, NY).map((m) => m?.kind)).toEqual(["day", "day"]);
    expect(timeMarks(times, "UTC").map((m) => m?.kind)).toEqual(["day", "gap"]);
  });

  it("passes over messages kept before messages kept their time", () => {
    const t = at("2026-11-18T09:00:00Z");
    expect(timeMarks([undefined, 0, t, undefined, t + 60_000], "UTC").map((m) => m?.kind)).toEqual([undefined, undefined, "day", undefined, undefined]);
    expect(timeMarks([undefined, undefined])).toEqual([undefined, undefined]);
  });
});

describe("what the lines say", () => {
  const now = at("2026-11-18T15:00:00-05:00");

  it("says Today, Yesterday, the weekday within the week and the full date before it", () => {
    expect(dayWords(at("2026-11-18T00:05:00-05:00"), now, "en-US", NY)).toBe("Today");
    expect(dayWords(at("2026-11-17T23:55:00-05:00"), now, "en-US", NY)).toBe("Yesterday");
    expect(dayWords(at("2026-11-16T12:00:00-05:00"), now, "en-US", NY)).toBe("Mon, Nov 16");
    expect(dayWords(at("2026-11-12T12:00:00-05:00"), now, "en-US", NY)).toBe("Thu, Nov 12");
    expect(dayWords(at("2026-11-11T12:00:00-05:00"), now, "en-US", NY)).toBe("Wed, Nov 11, 2026");
    expect(dayWords(at("2025-12-31T12:00:00-05:00"), now, "en-US", NY)).toBe("Wed, Dec 31, 2025");
  });

  it("reads a time a little ahead of the reader's clock as today, even across midnight", () => {
    const late = at("2026-11-18T23:59:00-05:00");
    expect(dayWords(late + 5 * 60_000, late, "en-US", NY)).toBe("Today");
    expect(dayWords(late + 3 * 3_600_000, late, "en-US", NY)).toBe("Thu, Nov 19, 2026");
  });

  it("says them in the reader's locale", () => {
    expect(dayWords(at("2026-11-18T09:00:00-05:00"), now, "fr-FR", NY)).toBe("Aujourd’hui");
    expect(dayWords(at("2026-11-17T09:00:00-05:00"), now, "de-DE", NY)).toBe("Gestern");
  });

  it("tells the time on the locale's own 12- or 24-hour clock", () => {
    const t = at("2026-11-18T21:41:00-05:00");
    expect(clockWords(t, "en-US", NY)).toMatch(/^9:41\sPM$/);
    expect(clockWords(t, "en-GB", NY)).toBe("21:41");
    expect(markWords({ kind: "gap", at: t }, now, "en-GB", NY)).toBe("21:41");
    expect(markWords({ kind: "day", at: t }, now, "en-GB", NY)).toBe("Today");
  });

  it("writes a moment as a list does: the time today, the day near it, the date past that", () => {
    const at9 = (iso: string): number => at(`${iso}T09:05:00-05:00`);
    expect(momentWords(at9("2026-11-18"), now, "en-US", NY)).toMatch(/^9:05\sAM$/);
    expect(momentWords(at9("2026-11-19"), now, "en-US", NY)).toMatch(/^Tomorrow 9:05\sAM$/);
    expect(momentWords(at9("2026-11-17"), now, "en-US", NY)).toMatch(/^Yesterday 9:05\sAM$/);
    expect(momentWords(at9("2026-11-21"), now, "en-US", NY)).toMatch(/^Sat 9:05\sAM$/);
    expect(momentWords(at9("2026-12-24"), now, "en-US", NY)).toMatch(/^Dec 24, 9:05\sAM$/);
    expect(momentWords(at9("2027-03-12"), now, "en-US", NY)).toMatch(/^Mar 12, 2027, 9:05\sAM$/);
    expect(momentWords(at9("2026-11-19"), now, "en-GB", NY)).toBe("Tomorrow 09:05");
  });
});
