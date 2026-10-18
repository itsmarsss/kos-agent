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

export const KINDS: { kind: ScheduleKind; label: string }[] = [
  { kind: "daily", label: "Daily" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
  { kind: "hourly", label: "Hourly" },
  { kind: "minutes", label: "Minutes" },
  { kind: "monthly", label: "Monthly" },
  { kind: "custom", label: "Custom" },
];

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
  const everyHour = /^\*\/(\d+)$/.exec(hour);
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
      return `${shape.minute} */${shape.every} * * *`;
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

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A cron line, in words.
 *
 * Only the shapes people actually write: a fixed time, an interval, a
 * weekday. Anything else is left to the expression itself rather than
 * guessed at, because a confident wrong reading is worse than none.
 */
export function describeCron(expr: string): string | null {
  const shape = shapeOf(expr);
  switch (shape.kind) {
    case "daily":
      return `Every day at ${shape.time}`;
    case "weekdays":
      return `Weekdays at ${shape.time}`;
    case "weekly":
      return shape.days.length === 1 ? `Every ${DAYS[shape.days[0]!]} at ${shape.time}` : `${shape.days.map((d) => SHORT[d]).join(", ")} at ${shape.time}`;
    case "hourly": {
      const each = shape.every === 1 ? "Every hour" : `Every ${shape.every} hours`;
      return shape.minute === 0 ? `${each}, on the hour` : `${each}, at ${String(shape.minute).padStart(2, "0")} past the hour`;
    }
    case "minutes":
      return shape.every === 1 ? "Every minute" : `Every ${shape.every} minutes`;
    case "monthly":
      return `On day ${shape.day} of each month at ${shape.time}`;
    case "custom": {
      // The one shape the picker does not write but people do: every minute.
      const parts = expr.trim().split(/\s+/);
      if (parts.length === 5 && parts[0] === "*" && parts[1] === "*") return "Every minute";
      return null;
    }
  }
}
