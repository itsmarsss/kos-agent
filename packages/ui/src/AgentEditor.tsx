import { useEffect, useState, type ReactElement } from "react";

import { api, type AgentDraft, type AgentInfo, type FaceLook, type ToolInfo } from "./api.js";
import { describeCron, PRESETS } from "./CronEditor.js";
import { Face } from "./Face.js";
import { FaceEditor } from "./FaceEditor.js";
import { Select } from "./Select.js";
import { ToolPicker } from "./ToolPicker.js";

/**
 * An agent's file as a form.
 *
 * Four parts, in the order the owner thinks about them: who it is (its
 * face, its name, what it is for), its brief, what it may reach, and when
 * it runs. The same controls the rest of the dashboard uses: the tool
 * families as a list to tick, a schedule with presets and read back in
 * words, memory and model as a choice of two.
 */

/** "price-watch" as a title: "Price watch". */
export function titleOf(name: string): string {
  const words = name.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Draft {
  name: string;
  description: string;
  brief: string;
  tools: string[] | null;
  memory: "own" | "shared";
  task: "reasoning" | "cheap";
  schedule: string;
  prompt: string;
  face: FaceLook;
}

const BLANK: Draft = { name: "", description: "", brief: "", tools: null, memory: "own", task: "reasoning", schedule: "", prompt: "", face: {} };
/** What the harness accepts as a name: it is a folder name and a thread id. */
const NAME_SHAPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function toDraft(a: AgentInfo): Draft {
  return {
    name: a.name,
    description: a.description,
    brief: a.brief,
    tools: a.tools?.length ? a.tools : null,
    memory: a.memory,
    task: a.task ?? "reasoning",
    schedule: a.schedule ?? "",
    prompt: a.prompt ?? "",
    face: a.face ?? {},
  };
}

function fromDraft(d: Draft): AgentDraft {
  return {
    name: d.name.trim().toLowerCase(),
    description: d.description.trim(),
    brief: d.brief.trim(),
    memory: d.memory,
    task: d.task,
    ...(d.tools && d.tools.length ? { tools: d.tools } : {}),
    ...(d.schedule.trim() ? { schedule: d.schedule.trim() } : {}),
    ...(d.prompt.trim() ? { prompt: d.prompt.trim() } : {}),
    ...(Object.keys(d.face).length ? { face: d.face } : {}),
  };
}

/** A choice of two, as two buttons. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string, string]>; onChange: (v: T) => void }): ReactElement {
  const chosen = options.find(([v]) => v === value);
  return (
    <div className="kos-field">
      <span className="kos-field-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" className={`seg-btn ${v === value ? "is-on" : ""}`} aria-pressed={v === value} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
      {chosen && <span className="hint">{chosen[2]}</span>}
    </div>
  );
}

export interface AgentEditorProps {
  /** The agent being changed; absent makes a new one. */
  initial?: AgentInfo;
  onSaved: (agent: AgentInfo) => void;
  onCancel: () => void;
}

export function AgentEditor({ initial, onSaved, onCancel }: AgentEditorProps): ReactElement {
  const [draft, setDraft] = useState<Draft>(initial ? toDraft(initial) : BLANK);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The names already in use, so a new one is told it is taken before it is sent. */
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
  const isNew = !initial;
  const readable = draft.schedule.trim() ? describeCron(draft.schedule.trim()) : null;
  const badSchedule = draft.schedule.trim() !== "" && readable === null;
  const name = draft.name.trim().toLowerCase();
  const nameTaken = isNew && name !== "" && taken.has(name);
  const nameOdd = name !== "" && !NAME_SHAPE.test(name);

  useEffect(() => {
    void api.tools().then(setTools).catch(() => setTools([]));
    if (isNew) void api.agents().then((r) => setTaken(new Set([...r.agents.map((a) => a.name), ...r.invalid.map((i) => i.name)]))).catch(() => undefined);
  }, [isNew]);

  const save = (): void => {
    if (busy || badSchedule || nameTaken || nameOdd) return;
    setBusy(true);
    setError(null);
    api
      .saveAgent(fromDraft(draft), { create: isNew })
      .then((r) => onSaved(r.agent))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const seed = draft.name || "new";
  return (
    <form
      className="agent-editor"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <section className="agent-editor-section">
        <h3>Who it is</h3>
        <div className="agent-editor-head">
          <Face seed={seed} look={draft.face} size={72} label={draft.name ? `${titleOf(draft.name)}'s face` : "A new agent's face"} />
          <div className="agent-editor-ident">
            <div className="agents-fields">
              <label className="kos-field">
                <span className="kos-field-label">Name</span>
                <input
                  className={`kos-input${nameTaken || nameOdd ? " is-invalid" : ""}`}
                  value={draft.name}
                  disabled={!isNew}
                  placeholder="price-watch"
                  autoFocus={isNew}
                  aria-invalid={nameTaken || nameOdd}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                {nameTaken ? (
                  <span className="field-error" role="alert">
                    An agent called {name} already exists. Pick another name, or edit that one.
                  </span>
                ) : nameOdd ? (
                  <span className="field-error" role="alert">
                    Letters, digits and dashes only, starting with a letter or digit.
                  </span>
                ) : (
                  isNew && <span className="hint">Short and plain: letters, digits, dashes. It names the folder and the thread.</span>
                )}
              </label>
              <label className="kos-field">
                <span className="kos-field-label">What it is for</span>
                <input className="kos-input" value={draft.description} placeholder="Watches one listing and says when it drops" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </label>
            </div>
            <FaceEditor seed={seed} value={draft.face} onChange={(face) => setDraft({ ...draft, face })} preview={false} />
          </div>
        </div>
      </section>

      <section className="agent-editor-section">
        <h3>Brief</h3>
        <textarea className="kos-input agents-brief" rows={10} value={draft.brief} placeholder="You watch one listing for the owner…" onChange={(e) => setDraft({ ...draft, brief: e.target.value })} />
        <span className="hint">Its standing instructions, in the second person: what it is for, how to do the work, when to tell you. It has a folder of its own, agents/{seed}/, for notes and anything it makes.</span>
      </section>

      <section className="agent-editor-section">
        <h3>Reach</h3>
        <div className="agents-fields agents-fields--reach">
          <div className="kos-field">
            <span className="kos-field-label">Tools</span>
            <ToolPicker tools={tools} allow={draft.tools} onChange={(allow) => setDraft({ ...draft, tools: allow })} />
          </div>
          <div className="agent-editor-stack">
            <Choice
              label="Memory"
              value={draft.memory}
              options={[
                ["own", "Its own", "What it learns stays in a scope of its own, read beside your global claims."],
                ["shared", "Shared", "The ordinary rule: the project it is in, or global."],
              ]}
              onChange={(memory) => setDraft({ ...draft, memory })}
            />
            <Choice
              label="Model"
              value={draft.task}
              options={[
                ["reasoning", "Reasoning", "The route that thinks; for judgement."],
                ["cheap", "Cheap", "The quick route; for routine checks."],
              ]}
              onChange={(task) => setDraft({ ...draft, task })}
            />
          </div>
        </div>
      </section>

      <section className="agent-editor-section">
        <h3>Schedule</h3>
        <div className="agents-fields">
          <div className="kos-field">
            <span className="kos-field-label">When</span>
            <div className="settings-row">
              <input className="kos-input kos-mono" value={draft.schedule} spellCheck={false} placeholder="not scheduled" onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} />
              <Select
                className="settings-select"
                label="Common schedules"
                value=""
                options={[{ value: "", label: "presets…" }, ...PRESETS.map((p) => ({ value: p.value, label: p.label, hint: p.value })), { value: "-", label: "Not scheduled" }]}
                onChange={(v) => {
                  if (v === "-") setDraft({ ...draft, schedule: "" });
                  else if (v) setDraft({ ...draft, schedule: v });
                }}
              />
            </div>
            <span className={`cron-reads ${badSchedule ? "is-bad" : ""}`}>
              {draft.schedule.trim() === "" ? "Not scheduled: it works when dispatched or spoken to." : (readable ?? "Not a schedule yet: five fields, minute to day of week.")}
            </span>
          </div>
          {draft.schedule.trim() !== "" && (
            <label className="kos-field">
              <span className="kos-field-label">On each run</span>
              <textarea className="kos-input" rows={3} value={draft.prompt} placeholder="Look at the listing and compare with what you remember." onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
              <span className="hint">What it is told each time, in its own thread.</span>
            </label>
          )}
        </div>
      </section>

      {error && <p className="ops-alert ops-alert--err">{error}</p>}
      <div className="rename-actions">
        <button type="submit" className="btn btn--primary" disabled={busy || badSchedule || nameTaken || nameOdd || !draft.name.trim() || !draft.description.trim() || !draft.brief.trim()}>
          {busy ? "Saving…" : isNew ? "Make it" : "Save"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
