import { useEffect, useState, type ReactElement } from "react";

import { Chips } from "@kos/kit";

import { KINDS, cronProblem, describeCron, exprOf, recast, shapeOf, type ScheduleKind, type ScheduleShape } from "./schedule.js";
import { WEEK } from "./schedulewords.js";

/**
 * When something runs, as choices.
 *
 * Five numbers and three stars is a format you either know or do not, and
 * getting it wrong means a job at a time you did not intend. So the common
 * shapes are picked: every day at a time, weekdays, some days of the week,
 * every few hours or minutes, a day of the month; the picker writes the cron
 * line. The line is read back in words under it, and stays an advanced
 * option to edit as text for anything the choices do not cover; a line the
 * choices cannot read stays as the text it is, open under Advanced, and one
 * that is no schedule at all says what is wrong with it (`cronProblem`).
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

  const custom = !none && shape.kind === "custom";
  const current: Pick | undefined = none ? "none" : custom ? undefined : shape.kind;
  const expr = none ? "" : raw;
  const problem = none ? null : cronProblem(expr);
  const words = none ? "Not scheduled: it works when asked." : (problem ?? describeCron(expr) ?? "On a schedule of its own, written as a line below.");
  // A line the choices cannot write is only editable as text, so it opens there.
  const lineShown = showRaw || custom;

  return (
    <div className="sched">
      <Chips
        label="How often"
        options={[...(allowNone ? [["none", "Never"] as const] : []), ...KINDS.map((k) => [k.kind, k.label] as const)]}
        {...(current ? { selected: current } : {})}
        onChoose={pick}
      />

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
          <span>On</span>
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
          <span>minutes past the hour</span>
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
      <div className="sched-foot">
        <span className={`cron-reads${problem ? " is-bad" : ""}`} {...(problem ? { role: "alert" } : {})}>
          {words}
        </span>
        {!none && !custom && (
          <button type="button" className="link sched-toggle" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Hide the line" : "Advanced: write the line"}
          </button>
        )}
      </div>
      {!none && lineShown && (
        <div className="sched-line">
          <input className="kos-input kos-mono sched-raw" value={raw} spellCheck={false} placeholder="0 9 * * 1-5" aria-label="The cron line" aria-invalid={problem ? true : undefined} onChange={(e) => typed(e.target.value)} />
          <span className="hint">Five parts: minute, hour, day of the month, month, day of the week. Pick a choice above to go back to them.</span>
        </div>
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
