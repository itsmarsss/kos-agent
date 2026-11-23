import { scheduleName, timeWords } from "@kos/shared";

/**
 * Small readings of a schedule for a panel: which days of the week a cron
 * line runs on, what a schedule is called, and when it last ran.
 */

/** Sunday first, as cron counts them. */
export const WEEK = ["S", "M", "T", "W", "T", "F", "S"] as const;

/**
 * The days of the week a cron line runs on, as a set of 0 (Sunday) to 6,
 * or null when the line is tied to dates rather than weekdays, or cannot
 * be read. "*" is every day; lists, ranges and steps are read as written.
 */
export function runDays(expr: string): Set<number> | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, , dom, mon, dow] = parts as [string, string, string, string, string];
  if (dom !== "*" || mon !== "*") return null;
  const days = new Set<number>();
  for (const piece of dow.split(",")) {
    const m = /^(\*|\d)(?:-(\d))?(?:\/(\d+))?$/.exec(piece.trim());
    if (!m) return null;
    const from = m[1] === "*" ? 0 : Number(m[1]);
    const to = m[1] === "*" ? 6 : m[2] !== undefined ? Number(m[2]) : from;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (from > 6 || to > 6 || to < from || step < 1) return null;
    for (let d = from; d <= to; d += step) days.add(d === 7 ? 0 : d);
  }
  return days;
}

/**
 * A schedule's name as every list writes it: KOS's own by the one name each
 * goes by (the memory schedules as "Memory: Read"), a blob's as the blob's
 * name, the owner's as they named it. The ids (kos.memory, blob.recap) are
 * the store's, kept for a tooltip.
 */
export function jobTitle(name: string): string {
  return scheduleName(name);
}

/** When a schedule last ran, as its row or panel says it: how long ago, or that it never has. */
export function lastRunWords(at: number | null | undefined, now = Date.now()): string {
  return at ? timeWords(at, now) : "Never run";
}
