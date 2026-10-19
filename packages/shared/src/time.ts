/**
 * A time written once and read on the reader's own clock.
 *
 * Discord renders `<t:1760845320:R>` as "in 3 hours" for whoever reads it,
 * and the owner wanted the same token to work everywhere KOS speaks. The
 * number was the trouble: the model worked unix seconds out by hand and got
 * them wrong, so the token here also takes the time as written,
 * `<t:2026-10-19T07:30:R>`, read in the owner's zone unless an offset says
 * otherwise, which the model can copy right off the clock line. Each
 * surface then renders the token its own way: Discord as its own token with
 * the seconds filled in, the dashboard as a live time, a text surface in
 * words.
 *
 * The style letters are Discord's: t 07:30, T 07:30:00, d 19/10/2026,
 * D 19 October 2026, f (the default) 19 October 2026 07:30, F Monday 19
 * October 2026 07:30, R "in 3 hours".
 */

export type TimeStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

/** One token: unix seconds or an ISO date or date-time, then a style letter. */
export const TIME_TOKEN = /<t:(\d{9,11}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?)(?::([tTdDfFR]))?>/;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Parts {
  weekday: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock in a zone at an instant; the machine's zone when none is given. */
function partsAt(ms: number, timeZone?: string): Parts {
  const read = (zone?: string): Parts => {
    const got = new Map(
      new Intl.DateTimeFormat("en-US", {
        ...(zone ? { timeZone: zone } : {}),
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(ms))
        .map((p) => [p.type, p.value]),
    );
    return {
      weekday: got.get("weekday") ?? "",
      year: Number(got.get("year")),
      month: MONTHS.indexOf(got.get("month") ?? "") + 1,
      day: Number(got.get("day")),
      hour: Number(got.get("hour")),
      minute: Number(got.get("minute")),
      second: Number(got.get("second")),
    };
  };
  // A zone the machine does not know is not worth a broken message.
  try {
    return read(timeZone);
  } catch {
    return read("UTC");
  }
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(ms: number, timeZone?: string): number {
  const whole = ms - (ms % 1000);
  const p = partsAt(whole, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/** The instant whose wall clock in the zone reads as `wall` (a UTC reading of the same digits). */
function zonedToUtc(wall: number, timeZone?: string): number {
  let guess = wall;
  // Twice: the offset at the first guess can differ from the offset at the answer across a DST change.
  for (let i = 0; i < 2; i += 1) guess = wall - offsetAt(guess, timeZone);
  return guess;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A token's moment in unix seconds, or nothing when it does not parse. A
 * time with no offset is read in `timeZone`, or the machine's zone without
 * one; a date alone is its midnight.
 */
export function instantOf(value: string, timeZone?: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const m = ISO.exec(value);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = m[7];
  if (offset === "Z") return wall / 1000;
  if (offset) {
    const digits = offset.slice(1).replace(":", "");
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    return wall / 1000 - (offset.startsWith("-") ? -1 : 1) * minutes * 60;
  }
  return Math.round(zonedToUtc(wall, timeZone) / 1000);
}

const two = (n: number): string => String(n).padStart(2, "0");

/** How far off a moment is, in words: "in 3 hours", "2 days ago", "in a moment". */
export function relativeWords(seconds: number, now = Date.now()): string {
  const diff = seconds - Math.floor(now / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return diff < 0 ? "just now" : "in a moment";
  const units: Array<[string, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  let words = "a minute";
  for (const [unit, size] of units) {
    const n = Math.round(abs / size);
    if (n >= 1 && abs >= size * 0.9) {
      words = n === 1 ? `${unit === "hour" ? "an" : "a"} ${unit}` : `${n} ${unit}s`;
      break;
    }
  }
  return diff < 0 ? `${words} ago` : `in ${words}`;
}

/** A moment in one of the styles, on the zone's clock; the machine's zone without one. */
export function formatTime(seconds: number, style: TimeStyle = "f", timeZone?: string, now = Date.now()): string {
  if (style === "R") return relativeWords(seconds, now);
  const p = partsAt(seconds * 1000, timeZone);
  const clock = `${two(p.hour)}:${two(p.minute)}`;
  const date = `${p.day} ${MONTHS[p.month - 1] ?? ""} ${p.year}`;
  switch (style) {
    case "t":
      return clock;
    case "T":
      return `${clock}:${two(p.second)}`;
    case "d":
      return `${two(p.day)}/${two(p.month)}/${p.year}`;
    case "D":
      return date;
    case "F":
      return `${p.weekday} ${date} ${clock}`;
    default:
      return `${date} ${clock}`;
  }
}

/** The style a token asked for, or the default. */
export function styleOf(letter: string | undefined): TimeStyle {
  return (letter ?? "f") as TimeStyle;
}

function everyToken(text: string, replace: (seconds: number, style: TimeStyle, raw: string) => string, timeZone?: string): string {
  return text.replace(new RegExp(TIME_TOKEN.source, "g"), (raw, value: string, letter: string | undefined) => {
    const seconds = instantOf(value, timeZone);
    return seconds === undefined ? raw : replace(seconds, styleOf(letter), raw);
  });
}

/** Every token in Discord's own form, `<t:seconds:style>`, with the time as written read in the zone. */
export function withUnixTimes(text: string, timeZone?: string): string {
  return everyToken(text, (seconds, style) => `<t:${seconds}:${style}>`, timeZone);
}

/** Every token as words on the zone's clock, for a surface that renders nothing. */
export function timesInWords(text: string, timeZone?: string, now = Date.now()): string {
  return everyToken(text, (seconds, style) => formatTime(seconds, style, timeZone, now), timeZone);
}
