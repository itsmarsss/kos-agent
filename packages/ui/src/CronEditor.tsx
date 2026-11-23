import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";

import { checkName, errorWords, formatDuration, momentWords, stateOfRun, SYSTEM_SCHEDULE_ABOUT } from "@kos/shared";
import { Field, SheetFoot, StatusPill, When } from "@kos/kit";

import { api, fieldErrorOf, type CronJob, type JobSpend, type RunRecord, type SkillInfo } from "./api.js";
import { scriptIn, withScript } from "./cronscript.js";
import { ConfirmButton } from "./kit.js";
import { cronProblem, describeCron } from "./schedule.js";
import { SchedulePicker } from "./SchedulePicker.js";
import { jobTitle } from "./schedulewords.js";
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
  /** What it does, in a line, said under the pick once it is picked. */
  about: string;
  name: string;
  schedule: string;
  /** A self-prompt job's instruction. */
  prompt?: string;
  /** Or fixed tool calls, for a job that needs no model. */
  actions?: { tool: string; args: Record<string, unknown> }[];
}[] = [
  {
    id: "brief",
    about: "Reads your calendar and mail, once those are added under Settings, MCP servers, and sends you the day in a message.",
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
    about: "Looks back at last week's projects and schedules and sends you what to do first.",
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
    about: "Reads a page and tells you when it changes. Needs no model, so it costs nothing to run.",
    label: "Watch a page",
    name: "Watch: example.com",
    schedule: "0 */6 * * *",
    // One fixed call and no model: the browser reads the page and says what
    // changed, and tells the owner itself.
    actions: [{ tool: "browser.watch", args: { url: "https://example.com", tell: true } }],
  },
  {
    id: "script",
    about: "Runs a script KOS wrote and you promoted, picked below. Needs no model.",
    label: "Run a script",
    name: "Run a script",
    schedule: "0 9 * * *",
    // A promoted script skill, picked below: no model turn, no ask.
    actions: [{ tool: "skills.run", args: { name: "" } }],
  },
  {
    id: "command",
    about: "Runs a command in the workspace. It asks the first time; press Always and it never asks again.",
    label: "Run a command",
    name: "Run a command",
    schedule: "0 */6 * * *",
    // A shell line in the workspace. It asks the first time; Always on that
    // ask remembers the program, and the runs after it are free.
    actions: [{ tool: "shell.run", args: { command: "echo hello" } }],
  },
];

/**
 * What a job's runs have cost, in one line: over its life, per run, and
 * the last run on its own. A job that runs a script makes no model call,
 * and the line says so: that is the saving over a job that thinks.
 */
export function spendWords(spend: JobSpend, thinks = false): string {
  const runs = `${spend.runs} run${spend.runs === 1 ? "" : "s"}`;
  // A job that asks KOS thinks on every run: none on record is a gap in the record, not a saving.
  if (spend.calls === 0) return thinks ? `${runs}; no model use is on record for them.` : `${runs}, no model turn: they cost no tokens.`;
  const each = (s: { inputTokens: number; outputTokens: number; cost?: number }): string =>
    `${tokens(s.inputTokens)} in, ${tokens(s.outputTokens)} out${s.cost !== undefined ? `, ${money(s.cost)}` : ""}`;
  const perRun = spend.cost !== undefined ? `, about ${money(spend.cost / spend.runs)} a run` : "";
  const last = spend.last && spend.last.calls > 0 ? ` Last run: ${each(spend.last)}.` : "";
  const unpriced = spend.cost === undefined ? " Set the model's rate under Settings for a figure." : "";
  return `${runs}: ${each(spend)}${perRun}.${last}${unpriced}`;
}

/**
 * Why a schedule has no run to show: off, or waiting for its first time.
 * Its runs, once it has some, say the rest.
 */
export function notRunWords(job: Pick<CronJob, "enabled" | "nextRunAt">): string {
  if (!job.enabled) return "It is off, so it does not run. Resume turns it back on.";
  return job.nextRunAt ? `It has not run yet. Its first run is ${momentWords(job.nextRunAt)}.` : "It has not run yet.";
}

/** A run's line on its sheet: why it did not run, or what went wrong, in words. */
export function runWhy(run: RunRecord): string | null {
  if (run.status === "skipped") return "Its condition said not now, so it did nothing.";
  return run.error ? errorWords(run.error) : null;
}

/** A schedule's last runs, newest first: when, how each went, and why, so nobody has to wait for the next to find out. */
function JobRuns({ job }: { job: CronJob }): ReactElement {
  const runs = job.lastRuns ?? [];
  return (
    <section className="set-group cron-runs" aria-label="Last runs">
      <h3>Last runs</h3>
      {runs.length === 0 ? (
        <p className="hint">{notRunWords(job)}</p>
      ) : (
        <ul className="cron-runs-list">
          {runs.map((r) => {
            const why = runWhy(r);
            return (
              <li key={r.id} className="cron-run">
                <StatusPill state={stateOfRun(r.status)} />
                <span className="cron-run-when">
                  <When at={r.startedAt} />
                  {r.durationMs ? ` · took ${formatDuration(r.durationMs)}` : ""}
                </span>
                {why && <span className="cron-run-why">{why}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {runs.length > 0 && (job.enabled ? job.nextRunAt && <p className="hint">Next run {momentWords(job.nextRunAt)}.</p> : <p className="hint">It is off now, so no run is coming. Resume turns it back on.</p>)}
    </section>
  );
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
  onNotice,
  hooks = false,
  taken = [],
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
  /** The other schedules' names, so a taken one is said as it is typed. */
  taken?: readonly string[];
  /** Says it was made or saved, for a toast. */
  onNotice?: (text: string) => void;
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
  // A blob's schedule is named for its blob, which owns the name; its field would show the store's id.
  const blobs = (job?.name ?? "").startsWith("blob.");
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
  const [template, setTemplate] = useState("");
  // What the server said of a field, until that field changes; an empty name is said once Save was tried.
  const [refused, setRefused] = useState<{ field: "name" | "schedule"; message: string } | null>(null);
  const [tried, setTried] = useState(false);
  const nameCheck = checkName(name, { noun: "schedule", taken });
  const nameError = refused?.field === "name" ? refused.message : nameCheck && (nameCheck.problem !== "empty" || tried) ? nameCheck.message : null;
  const whenError = refused?.field === "schedule" ? refused.message : cronProblem(schedule);
  const blocked = nameCheck !== null || whenError !== null || refused !== null;
  // The scripts a job may run without asking: promoted and on. Read once;
  // a job that runs one is a pick here rather than JSON to type.
  const [scripts, setScripts] = useState<SkillInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .skills()
      .then((r) => {
        if (!cancelled) setScripts(r.skills.filter((s) => s.kind === "script" && s.promoted === true && s.enabled));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = (): void => {
    setTried(true);
    if (blocked || saving) return;
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
      .then(() => {
        onNotice?.(`${job ? "Saved" : "Made"} ${jobTitle(name.trim())}`);
        onDone();
      })
      .catch((err: unknown) => {
        const onName = fieldErrorOf(err, "name");
        const onWhen = fieldErrorOf(err, "schedule");
        if (onName) setRefused({ field: "name", message: onName });
        else if (onWhen) setRefused({ field: "schedule", message: onWhen });
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSaving(false));
  };
  const canSave = !saving && name.trim() !== "";
  /** Enter in the name, or Cmd/Ctrl+Enter in a box of many lines, saves, as a sheet's form would. */
  const submitKeys = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey || e.altKey) return;
    const many = e.currentTarget instanceof HTMLTextAreaElement;
    if (many !== (e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (canSave) save();
  };


  return (
    // A form, so Enter in the name saves as it does in every other form; the buttons are plain buttons but Save.
    <form
      className="settings cron-editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {/* What this job is doing right now, and the two things worth doing to
          it while reading it. Trying a schedule meant closing the drawer and
          finding the row again, and waiting for tomorrow to find out. */}
      {job && (
        <div className="cron-state">
          <StatusPill state={job.enabled ? "on" : "off"} />
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
              {spendWords(job.spend, job.type === "self_prompt")}
            </p>
          )}
        </div>
      )}
      {job && <JobRuns job={job} />}
      {system && job ? (
        /* KOS's own: what it does, in words, and nothing to edit. Its brief
           is KOS's, and its fields would only invite breaking it. */
        <>
          <section className="set-group">
            <h3>What it does</h3>
            <p className="hint">{SYSTEM_SCHEDULE_ABOUT[job.name] ?? "Part of how KOS looks after itself."}</p>
            <p className="hint">One of KOS's own schedules: it can be paused or run now, and nothing else here changes it.</p>
          </section>
          <SheetFoot inline onCancel={onCancel} cancelLabel="Close" />
        </>
      ) : (
        <>

      <div className="set-group">
        <h3>When it runs</h3>
        {!job && (
          <Field
            label="Start from"
            hint={TEMPLATES.find((t) => t.id === template)?.about ?? "A ready-made schedule to change, or a blank one."}
          >
            <Select
              className="settings-select"
              label="Start from a template"
              value={template}
              options={[
                { value: "", label: "A blank schedule" },
                ...TEMPLATES.map((t) => ({ value: t.id, label: t.label, hint: describeCron(t.schedule) ?? t.schedule })),
              ]}
              onChange={(v) => {
                const t = TEMPLATES.find((x) => x.id === v);
                setTemplate(v);
                setRefused(null);
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
        {!blobs && (
        <Field label="Name" required hint="How it is named in lists, and in a message if it fails." {...(nameError ? { error: nameError } : {})}>
          <input
            className="kos-input"
            value={name}
            placeholder="Morning summary"
            aria-invalid={nameError ? true : undefined}
            onChange={(e) => {
              if (refused?.field === "name") setRefused(null);
              setName(e.target.value);
            }}
            onKeyDown={submitKeys}
          />
        </Field>
        )}

        {!system && (
          <Field label="Project" hint="Whose schedule this is. Its runs can use that project's files and tables, and show beside its chat.">
            <Select
              className="settings-select"
              label="Project"
              value={projectSlug}
              options={[
                { value: "", label: "None", hint: "yours, outside any project" },
                ...projects.map((p) => ({ value: p.slug, label: p.name })),
              ]}
              onChange={(v) => setProjectSlug(v)}
            />
          </Field>
        )}

        <Field label="When" required group>
          <SchedulePicker
            value={schedule}
            onChange={(expr) => {
              if (refused?.field === "schedule") setRefused(null);
              setSchedule(expr);
            }}
          />
          {refused?.field === "schedule" && (
            <span className="field-error" role="alert">
              {refused.message}
            </span>
          )}
        </Field>
      </div>

      <div className="set-group">
        <h3>What it does</h3>
        <p className="hint">
          KOS decides what to do each time, or the same steps run unchanged.
        </p>
        <Field label="Kind" group>
          <Select
            className="settings-select"
            label="What it does"
            value={type}
            options={[
              {
                value: "self_prompt",
                label: "Ask KOS",
                hint: "it reads, decides, then acts",
              },
              {
                value: "actions",
                label: "Fixed steps",
                hint: "exactly these, every time, no model",
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
              label="Model"
              value={task}
              options={[
                { value: "reasoning", label: "The model for thinking", hint: "the one your chats use" },
                { value: "cheap", label: "The cheap model", hint: "smaller and cheaper, for reading and filing" },
              ]}
              onChange={(v) => setTask(v === "cheap" ? "cheap" : "reasoning")}
            />
          </Field>
        )}
        {type === "self_prompt" ? (
          <Field label="What to do" required hint="Say it to KOS the way you would in a chat.">
            <textarea
              className="kos-input"
              rows={4}
              value={prompt}
              placeholder="Look at this week's expenses and message me anything unusual."
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={submitKeys}
            />
          </Field>
        ) : (
          <>
            <Field
              label="Script"
              hint={
                scripts.length
                  ? "A promoted script skill runs without asking. Picked here, it is the first call below; what follows it (a notify with {column} from the query, say) stays."
                  : "No promoted script skill yet. Ask KOS to write one and promote it, and it is a pick here."
              }
            >
              <Select
                className="settings-select"
                label="Script to run"
                value={scripts.some((s) => s.name === scriptIn(actions)) ? scriptIn(actions) : ""}
                options={[{ value: "", label: "None", hint: "the calls below, as written" }, ...scripts.map((s) => ({ value: s.name, label: s.name, hint: s.description }))]}
                onChange={(name) => setActions(withScript(actions, name))}
              />
            </Field>
            <Field label="Steps" required hint="Advanced: the steps as KOS writes them, run in order. A command asks the first time; Always on that ask stops it asking.">
              <textarea
                className="kos-input kos-mono"
                rows={7}
                value={actions}
                spellCheck={false}
                onChange={(e) => setActions(e.target.value)}
                onKeyDown={submitKeys}
              />
            </Field>
          </>
        )}
      </div>

      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      <SheetFoot
          inline
          onCancel={onCancel}
          /* The only delete lived in a panel the schedule list does not
             open, so from here a schedule could be paused forever and never
             removed. Apart, at the far left. */
          danger={job && onDelete && <ConfirmButton label="Delete" className="btn btn--danger" text={`Delete “${job.name}” and its runs?`} onConfirm={() => onDelete(job.id)} />}
          primary={
            <button type="submit" className="btn btn--primary" disabled={!canSave || blocked} aria-keyshortcuts="Meta+Enter">
              {saving ? "Saving…" : job ? "Save" : "Create"}
            </button>
          }
        />
        </>
      )}
    </form>
  );
}
