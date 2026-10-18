/**
 * Small readings of a schedule for a panel: which days of the week a cron
 * line runs on, and how far off a moment is, in a word or two.
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

/** "in 25m", "in 3h", "in 2d"; "now" once it is due. */
export function inWords(at: number, now = Date.now()): string {
  const mins = Math.round((at - now) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** "just now", "5m ago", "6h ago", "3d ago". */
export function agoWords(ts: number, now = Date.now()): string {
  if (now - ts < 60_000) return "just now";
  const mins = Math.round((now - ts) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A file size as people read one. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
