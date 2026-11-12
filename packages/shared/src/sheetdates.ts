/**
 * Dates in a sheet. A sheet keeps a date as ISO text (2026-09-02, or
 * 2026-09-02 14:30 with a time), and works with one as a spreadsheet does:
 * a serial, the days since 1899-12-30 (Excel's day 0 for every date after
 * February 1900), with the time of day as its fraction. So a date less a
 * date is the days between them, and a date plus 7 is a week on.
 *
 * Calendar arithmetic is in UTC, so a daylight-saving change never makes a
 * day 23 hours long; the clock (TODAY, NOW) is read in local time.
 */

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The serial of a calendar day; a month or day past its end rolls over, as DATE does. */
export const serialOf = (year: number, month: number, day: number): number => (Date.UTC(year, month - 1, day) - EPOCH) / DAY_MS;

/** The serial ISO text names, or undefined when it is not a real date. */
export function isoSerial(text: string): number | undefined {
  const m = ISO.exec(text.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = serialOf(y, mo, d);
  const back = partsOf(day);
  if (back.year !== y || back.month !== mo || back.day !== d) return undefined;
  const h = Number(m[4] ?? 0);
  const min = Number(m[5] ?? 0);
  const s = Number(m[6] ?? 0);
  if (h > 23 || min > 59 || s > 59) return undefined;
  return day + (h * 3600 + min * 60 + s) / 86_400;
}

/** A serial's calendar day. */
export function partsOf(serial: number): { year: number; month: number; day: number } {
  const d = new Date(EPOCH + Math.floor(serial) * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** A serial as ISO text: the day alone, or with its time when it has one. */
export function isoOf(serial: number): string {
  // To the second first, so a time a hair short of midnight is the next day at 00:00, not this one's 24:00.
  const total = Math.round(serial * 86_400);
  const whole = Math.floor(total / 86_400);
  const secs = total - whole * 86_400;
  const { year, month, day } = partsOf(whole);
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (secs === 0) return date;
  return `${date} ${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}${secs % 60 ? `:${pad(secs % 60)}` : ""}`;
}

/** The local date and time of a clock reading, as ISO text. */
export function localIso(now: Date, withTime: boolean): string {
  const date = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return withTime ? `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` : date;
}

const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** DATEDIF's units: whole years, months or days between two dates, or what is left of one over another. */
export type DateDiffUnit = "Y" | "M" | "D" | "MD" | "YM" | "YD";

/** The difference DATEDIF gives, start on or before end (the caller checks). */
export function dateDiff(start: number, end: number, unit: DateDiffUnit): number {
  const a = partsOf(start);
  const b = partsOf(end);
  const months = (b.year - a.year) * 12 + (b.month - a.month) - (b.day < a.day ? 1 : 0);
  switch (unit) {
    case "D":
      return Math.floor(end) - Math.floor(start);
    case "M":
      return months;
    case "Y":
      return Math.floor(months / 12);
    case "YM":
      return months % 12;
    case "MD": {
      if (b.day >= a.day) return b.day - a.day;
      // From the start's day in the month before the end's (its last day when shorter), never below zero as Excel's can be.
      const prev = b.month === 1 ? { year: b.year - 1, month: 12 } : { year: b.year, month: b.month - 1 };
      return Math.floor(end) - serialOf(prev.year, prev.month, Math.min(a.day, daysIn(prev.year, prev.month)));
    }
    case "YD": {
      const year = b.month > a.month || (b.month === a.month && b.day >= a.day) ? b.year : b.year - 1;
      const day = Math.min(a.day, daysIn(year, a.month));
      return Math.floor(end) - serialOf(year, a.month, day);
    }
  }
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A two-digit year as a spreadsheet reads one: 00 to 29 this century, 30 to 99 the last. */
const fullYear = (y: string): number => (y.length > 2 ? Number(y) : Number(y) + (Number(y) < 30 ? 2000 : 1900));

/** The ISO text of a calendar day, or undefined when there is no such day. */
function isoDay(year: number, month: number, day: number, time = ""): string | undefined {
  const text = `${pad(year, 4)}-${pad(month)}-${pad(day)}${time}`;
  return isoSerial(text) === undefined ? undefined : text;
}

/**
 * A date as people write one, as ISO text: 2026-11-12 (a time kept),
 * 2026/11/12, 11/12/2026 (month first, as the owner's spreadsheet writes it
 * unless the first number cannot be a month), 12.11.2026 (day first), and a
 * month by name (Nov 12, 2026; 12 November 2026; 12-Nov-26). Undefined when
 * it is none of these, or no real day.
 */
export function parseDate(text: string): string | undefined {
  const t = text.trim().replace(/^[a-z]{3,9},?\s+(?=\w)/i, (w) => (MONTH_NAMES.includes(w.slice(0, 3).toLowerCase()) ? w : ""));
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    const time = m[4] ? ` ${pad(Number(m[4]))}:${m[5]}${m[6] ? `:${m[6]}` : ""}` : "";
    return isoDay(Number(m[1]), Number(m[2]), Number(m[3]), time);
  }
  m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[3])];
    const dayFirst = m[2] === "." || a > 12;
    return isoDay(fullYear(m[4]!), dayFirst ? b : a, dayFirst ? a : b);
  }
  const month = (name: string): number => MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(t);
  if (m && month(m[1]!)) return isoDay(Number(m[3]), month(m[1]!), Number(m[2]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?[\s-]+(\d{2}|\d{4})$/i.exec(t);
  if (m && month(m[2]!)) return isoDay(fullYear(m[3]!), month(m[2]!), Number(m[1]));
  return undefined;
}
