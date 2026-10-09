import type { DayTotal, HourCount } from "./api.js";

/**
 * Shaping data for the small charts.
 *
 * Queries return only the buckets that had something in them. A chart needs
 * every bucket in the window, because the gaps are the information: two busy
 * days in a month must read as twice in a month, not as the last two days.
 */

const HOUR = 3_600_000;

export function isoDay(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/** One entry per day of the window, oldest first, including the quiet ones. */
export function padDays(
  rows: DayTotal[],
  windowDays: number,
  today = new Date(),
): DayTotal[] {
  const known = new Map(rows.map((r) => [r.day, r]));
  const out: DayTotal[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = isoDay(d);
    out.push(known.get(day) ?? { day, inputTokens: 0, outputTokens: 0 });
  }
  return out;
}

/** One entry per hour, oldest first, ending with the hour that is now. */
export function padHours(rows: HourCount[], hours: number, now = Date.now()): HourCount[] {
  const last = Math.floor(now / HOUR) * HOUR;
  const known = new Map(rows.map((r) => [r.hour, r]));
  const out: HourCount[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hour = last - i * HOUR;
    out.push(known.get(hour) ?? { hour, calls: 0, errors: 0 });
  }
  return out;
}

/** "3pm", "12am": the hour the way a clock on the wall says it. */
export function hourLabel(ms: number): string {
  const h = new Date(ms).getHours();
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${h < 12 ? "am" : "pm"}`;
}

/** "Mon", "Tue": the day a bar stands for. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

/** "2:05pm", for when a run is due. */
export function clockLabel(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/** Shorten a label so it fits a node with no room to wrap. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
