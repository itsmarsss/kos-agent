/**
 * Times in the owner's words.
 *
 * The model has no clock of its own and is handed epoch numbers and ISO
 * strings by tools, so it guessed the date from the transcript and did the
 * timezone arithmetic by hand, and got both wrong: a run "a year ago", a
 * recap dated in UTC for an owner in Toronto. These say a time the way the
 * owner would, in the owner's zone, so the model quotes rather than computes.
 */

const DAY_MS = 86_400_000;

/** The zone this machine keeps, which is the owner's unless they say otherwise. */
export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface Parts {
  weekday: string;
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
  zone: string;
  /** Days since the epoch, on the zone's own calendar. */
  dayIndex: number;
}

function partsOf(at: number, timeZone: string): Parts {
  const read = (zone: string): Parts => {
    // en-US for the zone's name: it says EDT where en-GB says GMT-4.
    const got = new Map(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short",
      })
        .formatToParts(new Date(at))
        .map((p) => [p.type, p.value]),
    );
    const monthIndex = new Date(`${got.get("month")} 1 2000`).getMonth();
    return {
      weekday: got.get("weekday") ?? "",
      day: got.get("day") ?? "",
      month: got.get("month") ?? "",
      year: got.get("year") ?? "",
      hour: got.get("hour") ?? "00",
      minute: got.get("minute") ?? "00",
      zone: got.get("timeZoneName") ?? zone,
      dayIndex: Math.floor(Date.UTC(Number(got.get("year")), monthIndex, Number(got.get("day"))) / DAY_MS),
    };
  };
  // A zone the machine does not know is not worth a failed turn.
  try {
    return read(timeZone);
  } catch {
    return read("UTC");
  }
}

/** The moment, in full: "Sunday 18 October 2026, 14:52 (America/Toronto, EDT)". */
export function clockLine(now: number, timeZone: string): string {
  const p = partsOf(now, timeZone);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} (${timeZone}, ${p.zone})`;
}

/**
 * A time as the owner would say it, relative to now: "today 18:00",
 * "tomorrow 07:30", "yesterday 21:19", "Mon 19 Oct 07:30" within the week
 * either way, and the date in full past that.
 */
export function whenWords(at: number, timeZone: string, now = Date.now()): string {
  const p = partsOf(at, timeZone);
  const clock = `${p.hour}:${p.minute}`;
  const days = p.dayIndex - partsOf(now, timeZone).dayIndex;
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  const short = `${p.day} ${p.month.slice(0, 3)}`;
  if (Math.abs(days) < 7) return `${p.weekday.slice(0, 3)} ${short} ${clock}`;
  return `${short} ${p.year} ${clock}`;
}
