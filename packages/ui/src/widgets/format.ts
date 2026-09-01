import type { Row } from "./types.js";

/** Small presentation helpers shared by the widget library. */

/**
 * Columns whose numbers are moments, not quantities. A stored epoch is just a
 * number, so every generated table with a created_at column rendered "1.8T".
 */
const TEMPORAL = /(^|_)(at|date|time|timestamp|due|since|on)$/i;

/** Columns whose numbers name a thing rather than measure one. */
const IDENTIFIER = /(^|_)(id|rowid|no|number|code|zip|postcode|year)$/i;

/** Epoch milliseconds: roughly 1973 to 5138, which covers anything real. */
const EPOCH_MS = [1e11, 1e14] as const;
/** Epoch seconds over the same span. */
const EPOCH_S = [1e9, 1e11] as const;

const DATE = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/**
 * Is this number a moment? The column name decides, and the value has to be
 * plausible as well: a column called "attempts_at_bat" holding 42 is a count,
 * and turning it into 1970 would be worse than leaving it alone.
 */
function asDate(value: number, column: string): string | null {
  if (!TEMPORAL.test(column)) return null;
  if (value >= EPOCH_MS[0] && value < EPOCH_MS[1]) return DATE.format(value);
  if (value >= EPOCH_S[0] && value < EPOCH_S[1]) return DATE.format(value * 1000);
  return null;
}

/**
 * Render any SQL value as display text; null and undefined read as empty.
 *
 * The column name is optional but worth passing: without it this can only go
 * on magnitude, and guessing a date from magnitude alone would corrupt a
 * genuinely large measure.
 */
export function formatCell(value: unknown, column?: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (column) {
      const date = asDate(value, column);
      if (date) return date;
      // An id is a name, not a measure. Row 12345 read "12.3K".
      if (IDENTIFIER.test(column)) return String(value);
    }
    return formatNumber(value);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const COMPACT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const PLAIN = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** Axis ticks and direct labels: compact past 10k, clean decimals below. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return Math.abs(value) >= 10000 ? COMPACT.format(value) : PLAIN.format(value);
}

/** "due_at" -> "Due at". Column names become field labels. */
export function humanize(column: string): string {
  const words = column.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Truncate axis/legend text so a long label cannot overrun its slot. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The column an update or delete keys on: an explicit id, else the first. */
export function keyColumn(row: Row | undefined): string | null {
  if (!row) return null;
  const columns = Object.keys(row);
  const id = columns.find((c) => /^(id|rowid|_id)$/i.test(c));
  return id ?? columns[0] ?? null;
}

/** Parse a SQL value as a finite number, or null if it is not numeric. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The value to seed an edit field with. Deliberately not formatCell: display
 * formatting adds thousands separators and compacts past 10k, so round-tripping
 * a formatted number through an edit would write "25K" back to the column.
 */
export function editValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
