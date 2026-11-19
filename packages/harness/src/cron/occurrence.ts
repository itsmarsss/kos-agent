import cron from "node-cron";

const MINUTE_MS = 60_000;

/** One formatter per timezone: building one costs far more than using it. */
const minuteFormats = new Map<string, Intl.DateTimeFormat>();

/** The minute of the hour it is at `at` in `timezone`, the host's when none. */
function localMinute(at: number, timezone: string | undefined): number {
  const key = timezone ?? "";
  let format = minuteFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { minute: "numeric", ...(timezone ? { timeZone: timezone } : {}) });
    minuteFormats.set(key, format);
  }
  return Number(format.formatToParts(at).find((p) => p.type === "minute")?.value ?? 0);
}

/**
 * The latest time a schedule came round in (after, now], or null when it
 * did not: whether a run was missed while nothing was listening.
 *
 * node-cron says when a schedule runs next, never when it last ran, and the
 * gap between the next two runs is no period for one that is not evenly
 * spaced (twice a day, weekdays only). So the schedule is walked back from
 * now, a local hour at a time, trying only the minutes and seconds it names,
 * and the task's own match (in its timezone, DST included) decides. The walk
 * stops at `after`, so it costs what the time offline costs.
 */
export function lastOccurrence(task: { match(date: Date): boolean }, schedule: string, timezone: string | undefined, now: number, after: number): number | null {
  const fields = cron.parse(schedule);
  const minutes = [...fields.minute].sort((a, b) => b - a);
  const seconds = [...fields.second].sort((a, b) => b - a);
  let cursor = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  while (cursor > after) {
    // The start of the local hour the cursor is in: zones are offset by whole quarter hours, so this is a whole minute.
    const hourStart = cursor - localMinute(cursor, timezone) * MINUTE_MS;
    for (const minute of minutes) {
      for (const second of seconds) {
        const at = hourStart + minute * MINUTE_MS + second * 1000;
        if (at > now) continue;
        if (at <= after) return null;
        if (task.match(new Date(at))) return at;
      }
    }
    cursor = hourStart - MINUTE_MS;
  }
  return null;
}
