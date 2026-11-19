/**
 * When a chat's messages were said, as every surface draws it.
 *
 * A thread reads as a conversation rather than a log, so its times stay
 * quiet: a line naming the day where the day changes, the time over a
 * message said after a long pause, and each message's own time on hover.
 * The rules here are the ones KOS for Mac and KOS for iPhone keep in Swift
 * (`ChatTimes` in DeviceCore), so the three surfaces mark the same places.
 * Each reads the clock in the reader's own zone and locale, on the locale's
 * own 12- or 24-hour clock.
 */

import { relativeWords, timeCard, type TimeStyle } from "./time.js";

/** A pause this long or longer between two messages puts the time over the second. */
export const GAP_MS = 15 * 60_000;

/** How far ahead of the reader's clock a time may be and still be read as now. */
const AHEAD_MS = 60 * 60_000;

/** A quiet line between messages: the day where it changes, the time after a pause. */
export type TimeMark = { kind: "day"; at: number } | { kind: "gap"; at: number };

/** Each formatter made once per locale, zone and shape: a long chat asks for every message's day and time on each draw. */
const formatters = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function kept<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat>(key: string, make: () => T): T {
  let made = formatters.get(key) as T | undefined;
  if (!made) {
    made = make();
    formatters.set(key, made);
  }
  return made;
}

const zoned = (timeZone?: string): { timeZone?: string } => (timeZone ? { timeZone } : {});

function calendarIn(timeZone?: string): Intl.DateTimeFormat {
  return kept(`calendar|${timeZone ?? ""}`, () => new Intl.DateTimeFormat("en-US", { ...zoned(timeZone), year: "numeric", month: "numeric", day: "numeric" }));
}

/** The calendar day an instant falls on in a zone, as days since 1970; the reader's zone without one. */
export function dayNumber(ms: number, timeZone?: string): number {
  const parts = new Map(
    calendarIn(timeZone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.get("year") ?? 1970, (parts.get("month") ?? 1) - 1, parts.get("day") ?? 1) / 86_400_000;
}

/**
 * The line over each message, given when each was said, in order: the day
 * over the first message of each day (the first one with a time too), the
 * time over one said `GAP_MS` or more after the one before it, and none
 * otherwise. A message with no time, kept before messages kept theirs, has
 * no line and is passed over.
 */
export function timeMarks(times: readonly (number | undefined)[], timeZone?: string): (TimeMark | undefined)[] {
  let last: number | undefined;
  return times.map((at) => {
    if (!at) return undefined;
    const before = last;
    last = at;
    if (before === undefined || dayNumber(at, timeZone) !== dayNumber(before, timeZone)) return { kind: "day", at };
    return at - before >= GAP_MS ? { kind: "gap", at } : undefined;
  });
}

/** A word with its first letter capitalised, as the locale capitalises it. */
function capitalised(word: string, locale?: string): string {
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
}

/**
 * What the line over a new day says: "Today", "Yesterday", the weekday and
 * date for the rest of the week ("Mon, Nov 17"), and the full date with its
 * year before that, each in the reader's locale.
 */
export function dayWords(ms: number, now = Date.now(), locale?: string, timeZone?: string): string {
  // A clock a little ahead of the reader's (another machine's) is still now.
  const when = ms > now && ms - now < AHEAD_MS ? now : ms;
  const ago = dayNumber(now, timeZone) - dayNumber(when, timeZone);
  if (ago === 0 || ago === 1) {
    const words = kept(`relative|${locale ?? ""}`, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));
    return capitalised(words.format(-ago, "day"), locale);
  }
  const recent = ago > 1 && ago < 7;
  const date = kept(`date|${recent ? "week" : "year"}|${locale ?? ""}|${timeZone ?? ""}`, () =>
    new Intl.DateTimeFormat(locale, { ...zoned(timeZone), weekday: "short", month: "short", day: "numeric", ...(recent ? {} : { year: "numeric" }) }),
  );
  return date.format(new Date(when));
}

/** A message's time on the reader's clock, hours and minutes: "9:41 AM", "21:41". */
export function clockWords(ms: number, locale?: string, timeZone?: string): string {
  return kept(`clock|${locale ?? ""}|${timeZone ?? ""}`, () => new Intl.DateTimeFormat(locale, { ...zoned(timeZone), timeStyle: "short" })).format(new Date(ms));
}

/**
 * A moment as a list or a schedule writes it, on the reader's clock: the
 * time alone today ("9:41 AM"), "Tomorrow 9:41 AM" or "Yesterday 9:41 AM",
 * the weekday within the week either way ("Mon 9:41 AM"), and the date
 * before or past that ("Nov 19, 9:41 AM", with the year when it is not this
 * year's). One shape for every clock time the dashboard shows.
 */
export function momentWords(ms: number, now = Date.now(), locale?: string, timeZone?: string): string {
  const clock = clockWords(ms, locale, timeZone);
  const away = dayNumber(ms, timeZone) - dayNumber(now, timeZone);
  if (away === 0) return clock;
  if (away === 1 || away === -1) {
    const words = kept(`relative|${locale ?? ""}`, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));
    return `${capitalised(words.format(away, "day"), locale)} ${clock}`;
  }
  if (Math.abs(away) < 7) {
    const day = kept(`weekday|${locale ?? ""}|${timeZone ?? ""}`, () => new Intl.DateTimeFormat(locale, { ...zoned(timeZone), weekday: "short" }));
    return `${day.format(new Date(ms))} ${clock}`;
  }
  const yearOf = (t: number): number => new Date(dayNumber(t, timeZone) * 86_400_000).getUTCFullYear();
  const sameYear = yearOf(ms) === yearOf(now);
  const date = kept(`moment|${sameYear ? "" : "year"}|${locale ?? ""}|${timeZone ?? ""}`, () =>
    new Intl.DateTimeFormat(locale, { ...zoned(timeZone), month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }),
  );
  return `${date.format(new Date(ms))}, ${clock}`;
}

/**
 * A time token's moment as a reader's surface draws it, in their locale and
 * on their clock: the clock alone for `t`, `momentWords` for the default,
 * the date in the locale's words for `d` and `D`, the hover card's words for
 * `F`, and "in 3 hours" for `R`. `formatTime` is the same for a surface that
 * has no reader to ask (a text message, a log).
 */
export function readerTime(seconds: number, style: TimeStyle, now = Date.now(), locale?: string, timeZone?: string): string {
  const ms = seconds * 1000;
  switch (style) {
    case "R":
      return relativeWords(seconds, now);
    case "t":
      return clockWords(ms, locale, timeZone);
    case "T":
      return kept(`clock-s|${locale ?? ""}|${timeZone ?? ""}`, () => new Intl.DateTimeFormat(locale, { ...zoned(timeZone), timeStyle: "medium" })).format(new Date(ms));
    case "d":
      return kept(`date-s|${locale ?? ""}|${timeZone ?? ""}`, () => new Intl.DateTimeFormat(locale, { ...zoned(timeZone), dateStyle: "short" })).format(new Date(ms));
    case "D":
      return kept(`date-l|${locale ?? ""}|${timeZone ?? ""}`, () => new Intl.DateTimeFormat(locale, { ...zoned(timeZone), dateStyle: "long" })).format(new Date(ms));
    case "F":
      return timeCard(seconds, locale, timeZone).join(" ");
    default:
      return momentWords(ms, now, locale, timeZone);
  }
}

/** What a mark says: the day's words, or the time after a pause. */
export function markWords(mark: TimeMark, now = Date.now(), locale?: string, timeZone?: string): string {
  return mark.kind === "day" ? dayWords(mark.at, now, locale, timeZone) : clockWords(mark.at, locale, timeZone);
}
