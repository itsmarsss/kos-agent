import { useState, type ReactElement } from "react";

import { api, type CronJob, type JobSpend } from "./api.js";
import { ConfirmButton, Field } from "./kit.js";
import { describeCron } from "./schedule.js";
import { SchedulePicker } from "./SchedulePicker.js";
import { Select } from "./Select.js";
import { money, tokens } from "./SpendPanel.js";

/**
 * Writing a schedule by hand.
 *
 * Everything here could already be asked for in a sentence, but a schedule is
 * the one thing that runs while nobody is watching, so it is worth being able
 * to read and change exactly what will happen rather than describing it and
 * hoping. Owner edits skip the approval queue: the queue exists to gate what
 * the agent proposes, not what the owner writes.
 */


/**
 * Whole jobs to start from.
 *
 * A blank prompt box asks the owner to invent the job that every assistant
 * is asked for first. These are written the way the owner would say them,
 * send their answer through notify (a job's reply otherwise stays in its
 * own thread), and say what to do when a calendar or mail tool is not
 * there, so they are useful before anything is wired and better after.
 */
export const TEMPLATES: {
  id: string;
  label: string;
  name: string;
  schedule: string;
  /** A self-prompt job's instruction. */
  prompt?: string;
  /** Or fixed tool calls, for a job that needs no model. */
  actions?: { tool: string; args: Record<string, unknown> }[];
}[] = [
  {
    id: "brief",
    label: "Morning brief",
    name: "Morning brief",
    schedule: "30 7 * * 1-5",
    prompt: [
      "Write my morning brief and send it to me with notify, as one message.",
      "Today's calendar first: each event with its time and where, and the first thing I have to be at.",
      "Then mail from the last 24 hours that needs a reply or a decision from me, one line each: who, and what they want.",
      "Then anything KOS has scheduled for today or left unfinished.",
      "Under twelve lines, plain text, no headers. Leave out a section with nothing in it.",
      "If a calendar or mail tool is not available, say so in one line and go on with the rest.",
    ].join("\n"),
  },
  {
    id: "review",
    label: "Weekly review",
    name: "Weekly review",
    schedule: "0 8 * * 1",
    prompt: [
      "Write my weekly review and send it to me with notify, as one message.",
      "What happened last week across my projects and schedules: what ran, what failed, what I decided.",
      "What this week's calendar holds, if a calendar tool is available.",
      "Then up to three things worth deciding or doing first.",
      "Under twenty lines, plain text, no headers.",
    ].join("\n"),
  },
  {
    id: "watch",
    label: "Watch a page",
    name: "Watch: example.com",
    schedule: "0 */6 * * *",
    // One fixed call and no model: the browser reads the page and says what
    // changed, and tells the owner itself.
    actions: [{ tool: "browser.watch", args: { url: "https://example.com", tell: true } }],
  },
];

/**
 * What a job's runs have cost, in one line: over its life, per run, and
 * the last run on its own. A job that runs a script makes no model call,
 * and the line says so: that is the saving over a job that thinks.
 */
export function spendWords(spend: JobSpend): string {
  const runs = `${spend.runs} run${spend.runs === 1 ? "" : "s"}`;
  if (spend.calls === 0) return `${runs}, no model turn: they cost no tokens.`;
  const each = (s: { inputTokens: number; outputTokens: number; cost?: number }): string =>
    `${tokens(s.inputTokens)} in, ${tokens(s.outputTokens)} out${s.cost !== undefined ? `, ${money(s.cost)}` : ""}`;
  const perRun = spend.cost !== undefined ? `, about ${money(spend.cost / spend.runs)} a run` : "";
  const last = spend.last && spend.last.calls > 0 ? ` Last run: ${each(spend.last)}.` : "";
  const unpriced = spend.cost === undefined ? " Set the model's rate under Settings for a figure." : "";
  return `${runs}: ${each(spend)}${perRun}.${last}${unpriced}`;
}

export function CronEditor({
  job,
  projects = [],
  defaultProject,
  onDone,
  onCancel,
  onRunNow,
  onToggle,
  onDelete,
  hooks = false,
}: {
  /** Absent when writing a new one. */
  job?: CronJob;
  /** Projects a job can belong to. */
  projects?: { slug: string; name: string }[];
  /** The project a new job starts in, when written from inside one. */
  defaultProject?: string;
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
  const [projectSlug, setProjectSlug] = useState(job?.projectSlug ?? defaultProject ?? "");
  // KOS's own jobs are nobody's project; the field would only mislead.
  const system = (job?.name ?? "").startsWith("kos.");
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
      // Left out rather than sent empty: the route reads a missing one as
      // "no project", which is also how a job is moved back to the root.
      ...(projectSlug && !system ? { projectSlug } : {}),
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
            {onDelete && <ConfirmButton label="Delete" text={`Delete “${job.name}” and its runs?`} onConfirm={() => onDelete(job.id)} />}
          </span>
          {/* Where an outside service posts to start this job. Only when
              the host has a hook secret; without one there is no address. */}
          {hooks && (
            <code className="cron-hook" title="POST here with the hook secret as a bearer token">
              POST /api/hooks/{encodeURIComponent(job.name)}
            </code>
          )}
          {/* What its runs cost, so a job that thinks and a job that runs a
              script can be held side by side; the script job's line says
              no model turn. */}
          {job.spend && (
            <p className="cron-spend" title="From the thread its runs are written into">
              {spendWords(job.spend)}
            </p>
          )}
        </div>
      )}

      <div className="set-group">
        <h3>When it runs</h3>
        <p className="hint">
          The name is how it is referred to everywhere else, including in a
          message about it failing.
        </p>
        {!job && (
          <Field
            label="Start from"
            hint="A whole job, written out; change any of it below. The brief reads your calendar and mail when those servers are added under Settings, MCP servers, and says what it could not read until then. A watch reads a page in the browser and tells you what changed, with no model turn."
          >
            <Select
              className="settings-select"
              label="Start from a template"
              value=""
              options={[
                { value: "", label: "a blank job" },
                ...TEMPLATES.map((t) => ({ value: t.id, label: t.label, hint: describeCron(t.schedule) ?? t.schedule })),
              ]}
              onChange={(v) => {
                const t = TEMPLATES.find((x) => x.id === v);
                if (!t) return;
                setName(t.name);
                setSchedule(t.schedule);
                if (t.actions) {
                  setType("actions");
                  setActions(JSON.stringify(t.actions, null, 2));
                } else {
                  setType("self_prompt");
                  setTask("reasoning");
                  setPrompt(t.prompt ?? "");
                }
              }}
            />
          </Field>
        )}
        <Field label="Name" required>
          <input
            className="kos-input"
            value={name}
            placeholder="Morning summary"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        {!system && (
          <Field label="Project" hint="Whose job this is. A self-prompt runs with the project's context; its runs sit in the project's rail.">
            <Select
              className="settings-select"
              label="Project"
              value={projectSlug}
              options={[
                { value: "", label: "None", hint: "yours, at the root" },
                ...projects.map((p) => ({ value: p.slug, label: p.name, hint: p.slug })),
              ]}
              onChange={(v) => setProjectSlug(v)}
            />
          </Field>
        )}

        <Field label="When" required group>
          <SchedulePicker value={schedule} onChange={setSchedule} />
        </Field>
      </div>

      <div className="set-group">
        <h3>What it does</h3>
        <p className="hint">
          Either KOS decides what to do each time, or the same calls run
          unchanged.
        </p>
        <Field label="Kind" group>
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
        </Field>

        {type === "self_prompt" && (
          <Field label="Model" group>
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
          </Field>
        )}
        {type === "self_prompt" ? (
          <Field label="Prompt" required hint="Written as an instruction to KOS, the way you would say it.">
            <textarea
              className="kos-input"
              rows={4}
              value={prompt}
              placeholder="Look at this week's expenses and message me anything unusual."
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
        ) : job?.name === "kos.backup" ? (
          <p className="hint">
            The built-in workspace backup: a git snapshot of the whole
            workspace, taken outside the tool path. It has no tool calls to
            edit; its schedule above is the only setting.
          </p>
        ) : (
          <Field label="Tool calls" required hint="Run in order. Nothing is substituted into them, so anything that has to read data and then report on it belongs in Ask KOS instead.">
            <textarea
              className="kos-input kos-mono"
              rows={7}
              value={actions}
              spellCheck={false}
              onChange={(e) => setActions(e.target.value)}
            />
          </Field>
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
