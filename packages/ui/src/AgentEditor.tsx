import { useEffect, useState, type ReactElement } from "react";
import { Chips, Face, Field, GroupHead, SheetFoot } from "@kos/kit";
import { checkName, slugWords } from "@kos/shared";

import { api, fieldErrorOf, type AgentDraft, type AgentInfo, type FaceLook, type ToolInfo } from "./api.js";
import { SchedulePicker } from "./SchedulePicker.js";
import { FaceEditor } from "./FaceEditor.js";
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
  return slugWords(name);
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
  /** Whether each run's answer is sent to the owner, or only what the brief says. */
  report: "always" | "brief";
  face: FaceLook;
}

const BLANK: Draft = { name: "", description: "", brief: "", tools: null, memory: "own", task: "reasoning", schedule: "", prompt: "", report: "brief", face: {} };
/** The longest name a blob takes: it names its folder and its thread. */
const BLOB_NAME_MAX = 64;

function toDraft(a: AgentInfo): Draft {
  return {
    name: a.name,
    description: a.description,
    brief: a.brief,
    tools: a.tools?.length ? a.tools : null,
    memory: a.memory,
    // Whose it is rides along, so an edit does not hand a project's blob to the root.
    ...(a.project ? { project: a.project } : {}),
    task: a.task ?? "reasoning",
    schedule: a.schedule ?? "",
    prompt: a.prompt ?? "",
    report: a.report ?? "brief",
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
    ...(d.report === "always" ? { report: "always" as const } : {}),
    ...(Object.keys(d.face).length ? { face: d.face } : {}),
  };
}

/** A choice of two, as two buttons. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string, string]>; onChange: (v: T) => void }): ReactElement {
  const chosen = options.find(([v]) => v === value);
  return (
    <div className="kos-field">
      <span className="kos-field-label">{label}</span>
      <Chips label={label} options={options.map(([v, text]) => [v, text] as const)} selected={value} onChoose={onChange} />
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
  /** The server's word on the name, shown under the field until the name changes. */
  const [nameRefused, setNameRefused] = useState<string | null>(null);
  const [looks, setLooks] = useState(false);
  /** The names already in use, so a new one is told it is taken before it is sent. */
  const [taken, setTaken] = useState<readonly string[]>([]);
  const isNew = !initial;
  // Five fields is a schedule as far as the form can tell; the host checks it properly.
  const badSchedule = draft.schedule.trim() !== "" && draft.schedule.trim().split(/\s+/).length !== 5;
  const name = draft.name.trim().toLowerCase();
  // The one name check the server makes; nothing is said of an empty name until Create is pressed.
  const nameCheck = isNew && name !== "" ? checkName(name, { noun: "blob", plain: true, max: BLOB_NAME_MAX, taken }) : null;
  const nameError = nameCheck?.message ?? nameRefused;

  useEffect(() => {
    void api.tools().then(setTools).catch(() => setTools([]));
    if (isNew) void api.agents().then((r) => setTaken([...r.agents.map((a) => a.name), ...r.invalid.map((i) => i.name)])).catch(() => undefined);
  }, [isNew]);

  const save = (): void => {
    if (busy || badSchedule || nameError) return;
    setBusy(true);
    setError(null);
    api
      .saveAgent(fromDraft(draft), { create: isNew })
      .then((r) => onSaved(r.agent))
      .catch((err: unknown) => {
        const onName = fieldErrorOf(err, "name");
        if (onName) setNameRefused(onName);
        else setError(err instanceof Error ? err.message : String(err));
      })
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
        <GroupHead as="h3" title="Who it is" />
        <div className="agent-editor-head">
          <Face seed={seed} look={draft.face} size={72} label={draft.name ? `${titleOf(draft.name)}'s face` : "A new blob's face"} />
          <div className="agent-editor-ident">
            <div className="agents-fields">
              <Field
                label="Name"
                required
                hint={isNew ? "Letters, digits and dashes, such as price-watch. It can't change later." : undefined}
                error={nameError ?? undefined}
              >
                <input
                  className="kos-input"
                  value={draft.name}
                  disabled={!isNew}
                  placeholder="price-watch"
                  autoFocus={isNew}
                  maxLength={BLOB_NAME_MAX + 16}
                  aria-invalid={nameError !== null}
                  onChange={(e) => {
                    setNameRefused(null);
                    setDraft({ ...draft, name: e.target.value });
                  }}
                />
              </Field>
              <Field label="What it is for" required hint="One line, as a list would show it.">
                <input className="kos-input" value={draft.description} placeholder="Watches one listing and says when it drops" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </Field>
            </div>
            <button type="button" className="link sched-toggle" aria-expanded={looks} onClick={() => setLooks((v) => !v)}>
              {looks ? "Hide its looks" : "Change its looks (optional)"}
            </button>
            {looks && <FaceEditor seed={seed} value={draft.face} onChange={(face) => setDraft({ ...draft, face })} preview={false} />}
          </div>
        </div>
      </section>

      <section className="agent-editor-section">
        <GroupHead as="h3" title="Brief" />
        <textarea className="kos-input agents-brief" rows={10} value={draft.brief} placeholder="You watch one listing for the owner…" onChange={(e) => setDraft({ ...draft, brief: e.target.value })} />
        <span className="hint">Its standing instructions, written to it as "you": what it looks after, how to do the work, and when to tell you. It keeps its notes and what it makes in a folder of its own.</span>
      </section>

      <section className="agent-editor-section">
        <GroupHead as="h3" title="Reach" />
        <div className="agents-fields agents-fields--reach">
          <Field label="Tools" group>
            <ToolPicker tools={tools} allow={draft.tools} onChange={(allow) => setDraft({ ...draft, tools: allow })} />
          </Field>
          <div className="agent-editor-stack">
            <Choice
              label="Memory"
              value={draft.memory}
              options={[
                ["own", "Its own", "What it learns stays with it. It still knows what KOS knows about you."],
                ["shared", "Shared", "What it learns goes where any chat's would: its project, or everywhere."],
              ]}
              onChange={(memory) => setDraft({ ...draft, memory })}
            />
            <Choice
              label="Model"
              value={draft.task}
              options={[
                ["reasoning", "Thinking", "The model for thinking: for work that needs judgement."],
                ["cheap", "Quick", "The cheap model: for routine checks."],
              ]}
              onChange={(task) => setDraft({ ...draft, task })}
            />
          </div>
        </div>
      </section>

      <section className="agent-editor-section">
        <GroupHead as="h3" title="Schedule" />
        <div className="agents-fields">
          <Field label="When" group>
            <SchedulePicker value={draft.schedule} allowNone onChange={(schedule) => setDraft({ ...draft, schedule })} />
          </Field>
          {draft.schedule.trim() !== "" && (
            <Field label="On each run" required hint="What it is told each time, in its own thread.">
              <textarea className="kos-input" rows={3} value={draft.prompt} placeholder="Look at the listing and compare with what you remember." onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
            </Field>
          )}
          {draft.schedule.trim() !== "" && (
            <Choice
              label="After each run"
              value={draft.report}
              options={[
                ["brief", "As the brief says", "You hear from it only when its instructions say to tell you."],
                ["always", "Tell me", "Its answer is sent to you every time, tagged as the blob's."],
              ]}
              onChange={(report) => setDraft({ ...draft, report })}
            />
          )}
        </div>
      </section>

      {error && <p className="ops-alert ops-alert--err">{error}</p>}
      <SheetFoot
        inline
        onCancel={onCancel}
        primary={
          <button type="submit" className="btn btn--primary" disabled={busy || badSchedule || nameError !== null || !draft.name.trim() || !draft.description.trim() || !draft.brief.trim() || (draft.schedule.trim() !== "" && !draft.prompt.trim())}>
            {busy ? "Saving…" : isNew ? "Create" : "Save"}
          </button>
        }
      />
    </form>
  );
}
