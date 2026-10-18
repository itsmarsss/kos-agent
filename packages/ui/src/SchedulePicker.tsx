import { useEffect, useState, type ReactElement } from "react";

import { KINDS, describeCron, exprOf, recast, shapeOf, type ScheduleKind, type ScheduleShape } from "./schedule.js";
import { WEEK } from "./schedulewords.js";

/**
 * When something runs, as choices.
 *
 * Five numbers and three stars is a format you either know or do not, and
 * getting it wrong means a job at a time you did not intend. So the common
 * shapes are picked: a time of day, which days, every so many hours or
 * minutes, a day of the month. The line it writes is read back in words
 * under it, and is there to edit as text for anything the choices do not
 * cover; a line the choices cannot read stays as the text it is.
 */

export interface SchedulePickerProps {
  /** The cron line; "" is no schedule. */
  value: string;
  onChange: (expr: string) => void;
  /** Offer "Not scheduled", for something that may run only when asked. */
  allowNone?: boolean;
}

type Pick = ScheduleKind | "none";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SchedulePicker({ value, onChange, allowNone = false }: SchedulePickerProps): ReactElement {
  // The shape is held here while it is being edited, since a weekly with no
  // day picked yet has no line to hand back; a value that changes under us
  // (a template, a reset) is read in.
  const [shape, setShape] = useState<ScheduleShape>(() => shapeOf(value));
  const [none, setNone] = useState(allowNone && value.trim() === "");
  const [raw, setRaw] = useState(value);
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => {
    if (value === raw) return;
    setRaw(value);
    setNone(allowNone && value.trim() === "");
    if (value.trim() !== "") setShape(shapeOf(value));
    // raw is ours: only the value changing under us matters here.
  }, [value]);

  const commit = (next: ScheduleShape): void => {
    setShape(next);
    setNone(false);
    const expr = exprOf(next);
    setRaw(expr);
    onChange(expr);
  };
  const pick = (kind: Pick): void => {
    if (kind === "none") {
      setNone(true);
      setRaw("");
      onChange("");
      return;
    }
    commit(recast(shape, kind));
  };
  const typed = (text: string): void => {
    setRaw(text);
    setNone(false);
    setShape(shapeOf(text));
    onChange(text);
  };

  const current: Pick = none ? "none" : shape.kind;
  const expr = none ? "" : raw;
  const words = none ? "Not scheduled: it works when asked." : expr.trim() === "" ? "Pick a day, or write the line." : (describeCron(expr) ?? "Not a schedule yet: five fields, minute to day of week.");
  const bad = !none && expr.trim() !== "" && describeCron(expr) === null;

  return (
    <div className="sched">
      <div className="seg sched-kinds" role="radiogroup" aria-label="How often">
        {allowNone && (
          <button type="button" className={`seg-btn${current === "none" ? " is-on" : ""}`} aria-pressed={current === "none"} onClick={() => pick("none")}>
            Never
          </button>
        )}
        {KINDS.map((k) => (
          <button key={k.kind} type="button" className={`seg-btn${current === k.kind ? " is-on" : ""}`} aria-pressed={current === k.kind} onClick={() => pick(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>

      {!none && shape.kind === "daily" && (
        <div className="sched-row">
          <span>Every day at</span>
          <TimeBox value={shape.time} onChange={(time) => commit({ ...shape, time })} />
        </div>
      )}
      {!none && shape.kind === "weekdays" && (
        <div className="sched-row">
          <span>Monday to Friday at</span>
          <TimeBox value={shape.time} onChange={(time) => commit({ ...shape, time })} />
        </div>
      )}
      {!none && shape.kind === "weekly" && (
        <div className="sched-row sched-row--wrap">
          <div className="daypick" role="group" aria-label="Days">
            {WEEK.map((d, i) => {
              const on = shape.days.includes(i);
              return (
                <button
                  key={i}
                  type="button"
                  className={`daypick-day${on ? " is-on" : ""}`}
                  aria-pressed={on}
                  aria-label={DAY_NAMES[i]}
                  title={DAY_NAMES[i]}
                  onClick={() => commit({ ...shape, days: on ? shape.days.filter((x) => x !== i) : [...shape.days, i] })}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <span>at</span>
          <TimeBox value={shape.time} onChange={(time) => commit({ ...shape, time })} />
        </div>
      )}
      {!none && shape.kind === "hourly" && (
        <div className="sched-row">
          <span>Every</span>
          <NumberBox value={shape.every} min={1} max={23} label="Hours" onChange={(every) => commit({ ...shape, every })} />
          <span>hours, at</span>
          <NumberBox value={shape.minute} min={0} max={59} label="Minutes past the hour" onChange={(minute) => commit({ ...shape, minute })} />
          <span>past the hour</span>
        </div>
      )}
      {!none && shape.kind === "minutes" && (
        <div className="sched-row">
          <span>Every</span>
          <NumberBox value={shape.every} min={1} max={59} label="Minutes" onChange={(every) => commit({ ...shape, every })} />
          <span>minutes</span>
        </div>
      )}
      {!none && shape.kind === "monthly" && (
        <div className="sched-row">
          <span>On day</span>
          <NumberBox value={shape.day} min={1} max={31} label="Day of the month" onChange={(day) => commit({ ...shape, day })} />
          <span>of each month at</span>
          <TimeBox value={shape.time} onChange={(time) => commit({ ...shape, time })} />
        </div>
      )}
      {!none && shape.kind === "custom" && (
        <div className="sched-row">
          <input className="kos-input kos-mono sched-raw" value={raw} spellCheck={false} placeholder="minute hour day month weekday" aria-label="The cron line" onChange={(e) => typed(e.target.value)} />
        </div>
      )}

      <div className="sched-foot">
        <span className={`cron-reads${bad ? " is-bad" : ""}`}>{words}</span>
        {!none && shape.kind !== "custom" && (
          <button type="button" className="link sched-toggle" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Hide the line" : "Edit as cron"}
          </button>
        )}
      </div>
      {!none && shape.kind !== "custom" && showRaw && (
        <input className="kos-input kos-mono sched-raw" value={raw} spellCheck={false} aria-label="The cron line" onChange={(e) => typed(e.target.value)} />
      )}
    </div>
  );
}

function TimeBox({ value, onChange }: { value: string; onChange: (time: string) => void }): ReactElement {
  return <input type="time" className="kos-input kos-input--time" value={value} step={60} aria-label="Time" onChange={(e) => e.target.value && onChange(e.target.value)} />;
}

function NumberBox({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (n: number) => void }): ReactElement {
  return (
    <input
      type="number"
      className="kos-input kos-input--n"
      value={value}
      min={min}
      max={max}
      aria-label={label}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isInteger(n) && n >= min && n <= max) onChange(n);
      }}
    />
  );
}
