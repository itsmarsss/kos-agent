import { useState, type ReactElement } from "react";

import { api, type AgentDraft, type AgentInfo, type FaceLook } from "./api.js";
import { FaceEditor } from "./FaceEditor.js";
import { Select } from "./Select.js";

/**
 * An agent's file as a form: the head as fields, the brief as the text it
 * is. One form for making an agent and for changing one, opened in a dialog
 * from wherever the agent is, so the page it sits on stays the agent's own.
 */

/** "price-watch" as a title: "Price watch". */
export function titleOf(name: string): string {
  const words = name.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The form's own shape: every field a string, so an input can hold it. */
interface Draft {
  name: string;
  description: string;
  brief: string;
  tools: string;
  memory: "own" | "shared";
  task: "reasoning" | "cheap";
  schedule: string;
  prompt: string;
  face: FaceLook;
}

const BLANK: Draft = { name: "", description: "", brief: "", tools: "", memory: "own", task: "reasoning", schedule: "", prompt: "", face: {} };

function toDraft(a: AgentInfo): Draft {
  return {
    name: a.name,
    description: a.description,
    brief: a.brief,
    tools: (a.tools ?? []).join(", "),
    memory: a.memory,
    task: a.task ?? "reasoning",
    schedule: a.schedule ?? "",
    prompt: a.prompt ?? "",
    face: a.face ?? {},
  };
}

function fromDraft(d: Draft): AgentDraft {
  const tools = d.tools.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    name: d.name.trim().toLowerCase(),
    description: d.description.trim(),
    brief: d.brief.trim(),
    memory: d.memory,
    task: d.task,
    ...(tools.length ? { tools } : {}),
    ...(d.schedule.trim() ? { schedule: d.schedule.trim() } : {}),
    ...(d.prompt.trim() ? { prompt: d.prompt.trim() } : {}),
    ...(Object.keys(d.face).length ? { face: d.face } : {}),
  };
}

export interface AgentEditorProps {
  /** The agent being changed; absent makes a new one. */
  initial?: AgentInfo;
  onSaved: (agent: AgentInfo) => void;
  onCancel: () => void;
}

export function AgentEditor({ initial, onSaved, onCancel }: AgentEditorProps): ReactElement {
  const [draft, setDraft] = useState<Draft>(initial ? toDraft(initial) : BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = !initial;

  const save = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api
      .saveAgent(fromDraft(draft))
      .then((r) => onSaved(r.agent))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="rename-form agent-editor"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {/* Its face, live as the name is typed: the name is what the look
          comes from, so a new agent is met before it is made. The three
          things the owner may set about it sit beside it. */}
      <div className="agents-editor-head">
        <div>
          <strong>{draft.name ? titleOf(draft.name) : "A new agent"}</strong>
          <span className="hint">{initial ? initial.path : "Its colour, shape and eyes come from its name unless you set them."}</span>
        </div>
      </div>
      <FaceEditor seed={draft.name || "new"} value={draft.face} onChange={(face) => setDraft({ ...draft, face })} label={draft.name ? `${titleOf(draft.name)}'s face` : "A new agent's face"} />
      <div className="agents-fields">
        <label className="kos-field">
          <span className="kos-field-label">Name</span>
          <input
            className="kos-input"
            value={draft.name}
            disabled={!isNew}
            placeholder="price-watch"
            autoFocus={isNew}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          {isNew && <span className="hint">Short and plain: letters, digits, dashes. It is the file's name and the thread's.</span>}
        </label>
        <label className="kos-field">
          <span className="kos-field-label">What it is for</span>
          <input
            className="kos-input"
            value={draft.description}
            placeholder="Watches one listing and says when it drops"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
      </div>
      <label className="kos-field">
        <span className="kos-field-label">Brief</span>
        <textarea
          className="kos-input agents-brief"
          rows={10}
          value={draft.brief}
          placeholder="You watch one listing for the owner…"
          onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
        />
        <span className="hint">Its standing instructions, in the second person: what it is for, how to do the work, when to tell you.</span>
      </label>
      <div className="agents-fields">
        <label className="kos-field">
          <span className="kos-field-label">Tools</span>
          <input className="kos-input" value={draft.tools} placeholder="all" onChange={(e) => setDraft({ ...draft, tools: e.target.value })} />
          <span className="hint">Families it may reach, comma-separated: browser, memory, files. Empty is the full toolkit.</span>
        </label>
        <label className="kos-field">
          <span className="kos-field-label">Memory</span>
          <Select
            className="settings-select"
            label="Memory"
            value={draft.memory}
            options={[
              { value: "own", label: "its own" },
              { value: "shared", label: "shared" },
            ]}
            onChange={(memory) => setDraft({ ...draft, memory: memory === "shared" ? "shared" : "own" })}
          />
          <span className="hint">Its own keeps what it learns in a scope of its own, read beside your global claims.</span>
        </label>
        <label className="kos-field">
          <span className="kos-field-label">Model</span>
          <Select
            className="settings-select"
            label="Model"
            value={draft.task}
            options={[
              { value: "reasoning", label: "reasoning" },
              { value: "cheap", label: "cheap" },
            ]}
            onChange={(task) => setDraft({ ...draft, task: task === "cheap" ? "cheap" : "reasoning" })}
          />
        </label>
      </div>
      <div className="agents-fields">
        <label className="kos-field">
          <span className="kos-field-label">Schedule</span>
          <input className="kos-input" value={draft.schedule} placeholder="0 9 * * 1" onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} />
          <span className="hint">A cron expression. Empty means it works only when asked.</span>
        </label>
        <label className="kos-field">
          <span className="kos-field-label">On each run</span>
          <textarea
            className="kos-input"
            rows={2}
            value={draft.prompt}
            placeholder="Look at the listing and compare with what you remember."
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
        </label>
      </div>
      {error && <p className="ops-alert ops-alert--err">{error}</p>}
      <div className="rename-actions">
        <button type="submit" className="btn btn--primary" disabled={busy || !draft.name.trim() || !draft.description.trim() || !draft.brief.trim()}>
          {busy ? "Saving…" : isNew ? "Make it" : "Save"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
