import { useState, type ReactElement } from "react";

import { api, type CronJob } from "./api.js";
import { Select } from "./Select.js";

/**
 * Writing a schedule by hand.
 *
 * Everything here could already be asked for in a sentence, but a schedule is
 * the one thing that runs while nobody is watching, so it is worth being able
 * to read and change exactly what will happen rather than describing it and
 * hoping. Owner edits skip the approval queue: the queue exists to gate what
 * the agent proposes, not what the owner writes.
 */

const PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 9am", value: "0 9 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
  { label: "Every Monday at 8am", value: "0 8 * * 1" },
  { label: "First of the month", value: "0 9 1 * *" },
];

/**
 * A cron line, in words.
 *
 * Only the shapes people actually write: a fixed time, an interval, a
 * weekday. Anything else is left to the expression itself rather than
 * guessed at, because a confident wrong reading is worse than none.
 */
export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const everyMinutes = /^\*\/(\d+)$/.exec(min);
  if (
    everyMinutes &&
    hour === "*" &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  ) {
    return `Every ${everyMinutes[1]} minutes`;
  }
  if (min === "*" && hour === "*") return "Every minute";

  if (!/^\d+$/.test(min)) return null;
  const at = (h: string): string =>
    `${h.padStart(2, "0")}:${min.padStart(2, "0")}`;

  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${everyHours[1]} hours, at ${min.padStart(2, "0")} past`;
  }
  if (!/^\d+$/.test(hour)) return null;

  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  if (dom === "*" && mon === "*" && dow === "*")
    return `Every day at ${at(hour)}`;
  if (dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) {
    return `Every ${days[Number(dow)]} at ${at(hour)}`;
  }
  if (dom === "*" && mon === "*" && dow === "1-5") {
    return `Weekdays at ${at(hour)}`;
  }
  if (/^\d+$/.test(dom) && mon === "*" && dow === "*") {
    return `On day ${dom} of each month at ${at(hour)}`;
  }
  return null;
}

export function CronEditor({
  job,
  onDone,
  onCancel,
  onRunNow,
  onToggle,
  onDelete,
  hooks = false,
}: {
  /** Absent when writing a new one. */
  job?: CronJob;
  /** Whether the host takes inbound hooks, so the job's address can be shown. */
  hooks?: boolean;
  onDone: () => void;
  onCancel: () => void;
  /** Fire it now, so "does this work" is not a day's wait per attempt. */
  onRunNow?: (id: number) => void;
  /** Turn it off without deleting it. */
  onToggle?: (id: number, enabled: boolean) => void;
  /** Remove it, and the thread its runs were written into. */
  onDelete?: (id: number) => void;
}): ReactElement {
  const [name, setName] = useState(job?.name ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "0 9 * * *");
  const [type, setType] = useState<"self_prompt" | "actions">(
    job?.type === "actions" ? "actions" : "self_prompt",
  );
  const [task, setTask] = useState<"reasoning" | "cheap">(job?.task === "cheap" ? "cheap" : "reasoning");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [actions, setActions] = useState(
    JSON.stringify(
      job?.actions ?? [{ tool: "notify", args: { text: "" } }],
      null,
      2,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = (): void => {
    setError(null);
    let parsed: unknown = undefined;
    if (type === "actions") {
      try {
        parsed = JSON.parse(actions);
      } catch {
        setError("The actions are not valid JSON.");
        return;
      }
    }
    setSaving(true);
    const body = {
      name,
      schedule,
      type,
      ...(type === "self_prompt" ? { prompt, task } : { actions: parsed }),
    };
    const call = job
      ? api.updateCron({ id: job.id, ...body })
      : api.createCron(body);
    void call
      .then(onDone)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setSaving(false));
  };

  const readable = describeCron(schedule);

  return (
    <div className="settings cron-editor">
      {/* What this job is doing right now, and the two things worth doing to
          it while reading it. Trying a schedule meant closing the drawer and
          finding the row again, and waiting for tomorrow to find out. */}
      {job && (
        <div className="cron-state">
          <span className={`cron-badge ${job.enabled ? "is-on" : "is-off"}`}>
            {job.enabled ? "On schedule" : "Paused"}
          </span>
          <span className="cron-extra">
            {onRunNow && (
              <button
                type="button"
                className="btn btn--sm"
                title="Run it now, through the same path the schedule uses"
                onClick={() => onRunNow(job.id)}
              >
                Run now
              </button>
            )}
            {onToggle && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => onToggle(job.id, !job.enabled)}
              >
                {job.enabled ? "Pause" : "Resume"}
              </button>
            )}
            {/* The only delete lived in a panel the schedule list does not
                open, so from here a job could be paused forever and never
                removed. */}
            {onDelete && (
              <button
                type="button"
                className="btn btn--sm btn--danger-ghost"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete “${job.name}”? Its runs go with it.`,
                    )
                  ) {
                    onDelete(job.id);
                  }
                }}
              >
                Delete
              </button>
            )}
          </span>
          {/* Where an outside service posts to start this job. Only when
              the host has a hook secret; without one there is no address. */}
          {hooks && (
            <code className="cron-hook" title="POST here with the hook secret as a bearer token">
              POST /api/hooks/{encodeURIComponent(job.name)}
            </code>
          )}
        </div>
      )}

      <div className="set-group">
        <h3>When it runs</h3>
        <p className="hint">
          The name is how it is referred to everywhere else, including in a
          message about it failing.
        </p>
        <label className="kos-field">
          <span className="kos-field-label">Name</span>
          <input
            className="kos-input"
            value={name}
            placeholder="Morning summary"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="kos-field">
          <span className="kos-field-label">When</span>
          <div className="settings-row">
            <input
              className="kos-input kos-mono"
              value={schedule}
              spellCheck={false}
              onChange={(e) => setSchedule(e.target.value)}
            />
            <Select
              className="settings-select"
              label="Common schedules"
              value=""
              options={[
                { value: "", label: "presets…" },
                ...PRESETS.map((p) => ({
                  value: p.value,
                  label: p.label,
                  hint: p.value,
                })),
              ]}
              onChange={(v) => v && setSchedule(v)}
            />
          </div>
          {/* Read back in words. Five numbers and three stars is a format you
            either know or do not, and getting it wrong means a job that runs
            at a time you did not intend and no way to notice from here. */}
          <span className={`cron-reads ${readable ? "" : "is-bad"}`}>
            {readable ??
              "Not a schedule yet: five fields, minute to day of week."}
          </span>
        </div>
      </div>

      <div className="set-group">
        <h3>What it does</h3>
        <p className="hint">
          Either KOS decides what to do each time, or the same calls run
          unchanged.
        </p>
        <div className="kos-field">
          <span className="kos-field-label">Kind</span>
          <Select
            className="settings-select"
            label="Job type"
            value={type}
            options={[
              {
                value: "self_prompt",
                label: "Ask KOS",
                hint: "reads, decides, then acts",
              },
              {
                value: "actions",
                label: "Fixed tool calls",
                hint: "exactly these, every time",
              },
            ]}
            onChange={(v) =>
              setType(v === "actions" ? "actions" : "self_prompt")
            }
          />
        </div>

        {type === "self_prompt" && (
          <div className="kos-field">
            <span className="kos-field-label">Model</span>
            <Select
              className="settings-select"
              label="Model class"
              value={task}
              options={[
                { value: "reasoning", label: "Reasoning", hint: "the model every chat turn uses" },
                { value: "cheap", label: "Cheap", hint: "the small model from Settings, for reading and filing" },
              ]}
              onChange={(v) => setTask(v === "cheap" ? "cheap" : "reasoning")}
            />
          </div>
        )}
        {type === "self_prompt" ? (
          <label className="kos-field">
            <span className="kos-field-label">Prompt</span>
            <textarea
              className="kos-input"
              rows={4}
              value={prompt}
              placeholder="Look at this week's expenses and message me anything unusual."
              onChange={(e) => setPrompt(e.target.value)}
            />
            <span className="hint">
              Written as an instruction to KOS, the way you would say it.
            </span>
          </label>
        ) : (
          <label className="kos-field">
            <span className="kos-field-label">Tool calls</span>
            <textarea
              className="kos-input kos-mono"
              rows={7}
              value={actions}
              spellCheck={false}
              onChange={(e) => setActions(e.target.value)}
            />
            <span className="hint">
              Run in order. Nothing is substituted into them, so anything that
              has to read data and then report on it belongs in Ask KOS instead.
            </span>
          </label>
        )}
      </div>

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      <div className="settings-actions cron-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || !name.trim()}
          onClick={save}
        >
          {saving ? "Saving…" : job ? "Save changes" : "Create schedule"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
