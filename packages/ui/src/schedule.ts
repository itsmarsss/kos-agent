import { clockWords } from "@kos/shared";

/**
 * A schedule as a shape rather than five fields.
 *
 * Nearly every job is one of a few shapes: every day at a time, weekdays,
 * some days of the week, every few hours or minutes, a day of the month.
 * The picker edits those as choices and writes the cron line; a line that
 * is none of them is "custom" and edited as text. Reading a line back into
 * a shape is exact: only a line the picker itself would write is read as
 * one of its shapes, so the text never changes under the owner's hands.
 */

export type ScheduleShape =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "hourly"; every: number; minute: number }
  | { kind: "minutes"; every: number }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "custom"; expr: string };

export type ScheduleKind = ScheduleShape["kind"];

/** The shapes the picker offers, in the words of its chips; a line none of them writes is edited as text, under Advanced. */
export const KINDS: { kind: Exclude<ScheduleKind, "custom">; label: string }[] = [
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Some days" },
  { kind: "hourly", label: "Every few hours" },
  { kind: "minutes", label: "Every few minutes" },
  { kind: "monthly", label: "Monthly" },
];

/** Each of the five fields of a cron line: its name in a sentence and the numbers it takes. */
const CRON_FIELDS: readonly { name: string; min: number; max: number; names?: readonly string[] }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "day of the week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

/** A value of one field: a number in its range, or a month's or a day's name. */
function valueOk(v: string, f: (typeof CRON_FIELDS)[number]): boolean {
  if (/^\d+$/.test(v)) return Number(v) >= f.min && Number(v) <= f.max;
  return f.names?.includes(v.toLowerCase()) ?? false;
}

/** One comma-separated part: *, a value, a range, either stepped by /n. */
function partOk(part: string, f: (typeof CRON_FIELDS)[number]): boolean {
  const [base, step, extra] = part.split("/");
  if (extra !== undefined || base === undefined || base === "") return false;
  if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) return false;
  if (base === "*") return true;
  const [from, to, more] = base.split("-");
  if (more !== undefined || from === undefined) return false;
  return to === undefined ? valueOk(from, f) : valueOk(from, f) && valueOk(to, f);
}

/**
 * What is wrong with a cron line, in the owner's words, or null when it is
 * one: the line a schedule is written in, checked before Create so a bad one
 * never reaches KOS to be refused there.
 */
export function cronProblem(expr: string): string | null {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Pick when it runs.";
  if (parts.length !== 5) return `A schedule line has five parts: minute, hour, day of the month, month, day of the week. This has ${parts.length}.`;
  for (const [i, f] of CRON_FIELDS.entries()) {
    if (!parts[i]!.split(",").every((p) => partOk(p, f))) return `The ${f.name} must be ${f.min} to ${f.max}, *, or a range such as ${f.min}-${f.min + 2}.`;
  }
  return null;
}

const TIME = /^(\d{1,2}):(\d{2})$/;

function timeOf(min: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fields(time: string): { min: string; hour: string } | null {
  const m = TIME.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return { min: String(mm), hour: String(h) };
}

/** The shape a cron line is, or custom when it is none the picker writes. */
export function shapeOf(expr: string): ScheduleShape {
  const custom: ScheduleShape = { kind: "custom", expr };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (mon !== "*") return custom;

  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*" && dom === "*" && dow === "*") {
    const n = Number(everyMin[1]);
    return n >= 1 && n <= 59 ? { kind: "minutes", every: n } : custom;
  }
  // "15 * * * *" is every hour at :15, as "15 */1 * * *" is.
  const everyHour = hour === "*" ? ["*", "1"] : /^\*\/(\d+)$/.exec(hour);
  if (everyHour && /^\d{1,2}$/.test(min) && dom === "*" && dow === "*") {
    const n = Number(everyHour[1]);
    const m = Number(min);
    return n >= 1 && n <= 23 && m <= 59 ? { kind: "hourly", every: n, minute: m } : custom;
  }
  const time = timeOf(min, hour);
  if (!time) return custom;
  if (dom === "*" && dow === "*") return { kind: "daily", time };
  if (dom === "*" && dow === "1-5") return { kind: "weekdays", time };
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
    const days = [...new Set(dow.split(",").map(Number))].sort((a, b) => a - b);
    return { kind: "weekly", days, time };
  }
  if (/^\d{1,2}$/.test(dom) && dow === "*") {
    const day = Number(dom);
    return day >= 1 && day <= 31 ? { kind: "monthly", day, time } : custom;
  }
  return custom;
}

/** The cron line for a shape. */
export function exprOf(shape: ScheduleShape): string {
  switch (shape.kind) {
    case "daily": {
      const f = fields(shape.time);
      return f ? `${f.min} ${f.hour} * * *` : "";
    }
    case "weekdays": {
      const f = fields(shape.time);
      return f ? `${f.min} ${f.hour} * * 1-5` : "";
    }
    case "weekly": {
      const f = fields(shape.time);
      const days = [...new Set(shape.days)].sort((a, b) => a - b);
      return f && days.length ? `${f.min} ${f.hour} * * ${days.join(",")}` : "";
    }
    case "hourly":
      return `${shape.minute} ${shape.every === 1 ? "*" : `*/${shape.every}`} * * *`;
    case "minutes":
      return `*/${shape.every} * * * *`;
    case "monthly": {
      const f = fields(shape.time);
      return f ? `${f.min} ${f.hour} ${shape.day} * *` : "";
    }
    case "custom":
      return shape.expr;
  }
}

/** A shape of the asked kind, keeping what carries over from the one before: the time, the days. */
export function recast(from: ScheduleShape, kind: ScheduleKind): ScheduleShape {
  const time = "time" in from ? from.time : "09:00";
  switch (kind) {
    case "daily":
      return { kind, time };
    case "weekdays":
      return { kind, time };
    case "weekly":
      return { kind, days: from.kind === "weekly" ? from.days : from.kind === "weekdays" ? [1, 2, 3, 4, 5] : [1], time };
    case "hourly":
      return { kind, every: from.kind === "hourly" ? from.every : 6, minute: from.kind === "hourly" ? from.minute : 0 };
    case "minutes":
      return { kind, every: from.kind === "minutes" ? from.every : 15 };
    case "monthly":
      return { kind, day: from.kind === "monthly" ? from.day : 1, time };
    case "custom":
      return { kind, expr: exprOf(from) };
  }
}

/** A picker's "08:00" on the reader's own clock: "8:00 AM", or "08:00" where the day has 24 hours. */
function spoken(time: string, locale?: string): string {
  const m = TIME.exec(time);
  if (!m) return time;
  return clockWords(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2])), locale, "UTC");
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A cron line, in words.
 *
 * Only the shapes people actually write: a fixed time, an interval, a
 * weekday. Anything else is left to the expression itself rather than
 * guessed at, because a confident wrong reading is worse than none.
 */
export function describeCron(expr: string, locale?: string): string | null {
  const shape = shapeOf(expr);
  const at = "time" in shape ? spoken(shape.time, locale) : "";
  switch (shape.kind) {
    case "daily":
      return `Every day at ${at}`;
    case "weekdays":
      return `Weekdays at ${at}`;
    case "weekly":
      return shape.days.length === 1 ? `Every ${DAYS[shape.days[0]!]} at ${at}` : `${shape.days.map((d) => SHORT[d]).join(", ")} at ${at}`;
    case "hourly": {
      const each = shape.every === 1 ? "Every hour" : `Every ${shape.every} hours`;
      return shape.minute === 0 ? `${each}, on the hour` : `${each}, at ${String(shape.minute).padStart(2, "0")} past the hour`;
    }
    case "minutes":
      return shape.every === 1 ? "Every minute" : `Every ${shape.every} minutes`;
    case "monthly":
      return `On day ${shape.day} of each month at ${at}`;
    case "custom": {
      // The one shape the picker does not write but people do: every minute.
      const parts = expr.trim().split(/\s+/);
      if (parts.length === 5 && parts[0] === "*" && parts[1] === "*") return "Every minute";
      return null;
    }
  }
}

/**
 * A schedule as the owner reads it, wherever one is shown: its words, or
 * "On a custom schedule" for a line too unusual to read back. The cron line
 * itself is for a tooltip, never the words on the page.
 */
export function scheduleWords(expr: string | null | undefined, locale?: string): string {
  if (!expr) return "When asked";
  return describeCron(expr, locale) ?? "On a custom schedule";
}
