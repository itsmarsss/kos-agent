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

export function CronEditor({
  job,
  onDone,
  onCancel,
}: {
  /** Absent when writing a new one. */
  job?: CronJob;
  onDone: () => void;
  onCancel: () => void;
}): ReactElement {
  const [name, setName] = useState(job?.name ?? "");
  const [schedule, setSchedule] = useState(job?.schedule ?? "0 9 * * *");
  const [type, setType] = useState<"self_prompt" | "actions">(
    job?.type === "actions" ? "actions" : "self_prompt",
  );
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [actions, setActions] = useState(
    JSON.stringify(job?.actions ?? [{ tool: "notify", args: { text: "" } }], null, 2),
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
      ...(type === "self_prompt" ? { prompt } : { actions: parsed }),
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

  return (
    <div className="settings">
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
            className="kos-input"
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
              ...PRESETS.map((p) => ({ value: p.value, label: p.label, hint: p.value })),
            ]}
            onChange={(v) => v && setSchedule(v)}
          />
        </div>
        <span className="hint">
          Five fields: minute, hour, day of month, month, day of week.
        </span>
      </div>

      <div className="kos-field">
        <span className="kos-field-label">What it does</span>
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
          onChange={(v) => setType(v === "actions" ? "actions" : "self_prompt")}
        />
      </div>

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
            Run in order. Nothing is substituted into them, so anything that has
            to read data and then report on it belongs in Ask KOS instead.
          </span>
        </label>
      )}

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      <div className="settings-actions">
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
