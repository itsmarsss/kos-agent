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

/** What a mark says: the day's words, or the time after a pause. */
export function markWords(mark: TimeMark, now = Date.now(), locale?: string, timeZone?: string): string {
  return mark.kind === "day" ? dayWords(mark.at, now, locale, timeZone) : clockWords(mark.at, locale, timeZone);
}
