import { useCallback, useEffect, useState, type ReactElement } from "react";

import { api, type AgentDraft, type AgentInfo, type InvalidAgent } from "./api.js";
import { Face, type Mood } from "./Face.js";
import { hrefFor } from "./routes.js";
import { Select } from "./Select.js";

/**
 * The standing agents, with each one's file editable in place.
 *
 * An agent is a file under agents/, and KOS makes them from a request; this
 * page is where the owner reads what was made and changes it without going
 * through Files. The list is the agents; the editor is the one open, its
 * head as fields and its brief as the text it is.
 */

export interface AgentsPageProps {
  /** The agent open in the editor, by name; "new" for a blank one. */
  open?: string;
  onOpen: (agent?: string) => void;
  onOpenThread: (id: string) => void;
  onNotice: (text: string) => void;
  /** Something changed that the rest of the app lists: a thread, a job. */
  onChanged: () => void;
  /** What each agent's thread is doing, by name, so its face can say. */
  activity?: ReadonlyMap<string, Mood>;
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
}

const BLANK: Draft = { name: "", description: "", brief: "", tools: "", memory: "own", task: "reasoning", schedule: "", prompt: "" };

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
  };
}

function ago(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "price-watch" as a title: "Price watch". */
function titleOf(name: string): string {
  const words = name.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function AgentsPage({ open, onOpen, onOpenThread, onNotice, onChanged, activity }: AgentsPageProps): ReactElement {
  /** Its face: asleep when its schedule is paused, else whatever its thread is doing. */
  const moodFor = (a: AgentInfo): Mood => (a.job && !a.job.enabled ? "asleep" : activity?.get(a.name) ?? "idle");
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [invalid, setInvalid] = useState<InvalidAgent[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (): Promise<AgentInfo[]> => {
    const r = await api.agents();
    setAgents(r.agents);
    setInvalid(r.invalid);
    return r.agents;
  }, []);
  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  // The route says which is open; the draft follows it, from the list.
  useEffect(() => {
    setConfirmDelete(false);
    setError(null);
    if (!open) {
      setDraft(null);
      return;
    }
    if (open === "new") {
      setDraft(BLANK);
      return;
    }
    const found = agents?.find((a) => a.name === open);
    if (found) setDraft(toDraft(found));
  }, [open, agents]);

  const current = open && open !== "new" ? agents?.find((a) => a.name === open) : undefined;
  const isNew = open === "new";

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!draft) return;
    void run(async () => {
      const body = fromDraft(draft);
      const { agent } = await api.saveAgent(body);
      await load();
      onChanged();
      onNotice(isNew ? `Made ${agent.name}` : `Saved ${agent.name}`);
      if (isNew) onOpen(agent.name);
    });
  };

  const remove = (): void => {
    if (!current) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    void run(async () => {
      await api.deleteAgent(current.name);
      await load();
      onChanged();
      onNotice(`Removed ${current.name}; its thread stays as a chat`);
      onOpen();
    });
  };

  const runNow = (): void => {
    if (!current?.job) return;
    void run(async () => {
      await api.runAgent(current.name);
      onNotice(`${titleOf(current.name)} is running in its thread`);
      onChanged();
    });
  };

  return (
    <div className="projects agents">
      <div className="projects-head">
        <h1>Agents</h1>
        <button type="button" className="btn btn--primary" onClick={() => onOpen("new")}>
          New agent
        </button>
      </div>
      <p className="hint">
        A standing agent is a responsibility KOS keeps for you: a file under agents/ with a thread of its own and a schedule
        if it needs one. Ask KOS for one in a chat ("keep an eye on…", "every Saturday…"), or write one here.
      </p>

      <div className="agents-split">
        <ul className="agents-list">
          {agents === null && <li className="hint">Loading…</li>}
          {agents?.length === 0 && <li className="hint">None yet. Ask KOS to keep something up for you, or make one with New agent.</li>}
          {agents?.map((a) => (
            <li key={a.name}>
              <button
                type="button"
                className={`agents-row ${a.name === open ? "is-active" : ""}`}
                onClick={() => onOpen(a.name)}
              >
                <span className="agents-row-top">
                  <span className="agents-row-who">
                    <Face seed={a.name} size={26} mood={moodFor(a)} />
                    <span className="card-name">{titleOf(a.name)}</span>
                  </span>
                  <span className="chats-badge">{a.job ? (a.job.enabled ? "scheduled" : "paused") : "on request"}</span>
                </span>
                <span className="agents-row-desc">{a.description}</span>
                <span className="agents-row-meta">
                  {a.job ? `${a.job.schedule}${a.job.lastRunAt ? ` · last run ${ago(a.job.lastRunAt)}` : " · not run yet"}` : "runs when dispatched or spoken to"}
                </span>
              </button>
            </li>
          ))}
          {invalid.map((bad) => (
            <li key={bad.path} className="agents-invalid">
              <span className="card-name">{bad.name}</span>
              <span className="agents-row-desc">
                Does not read as an agent: {bad.reason}.{" "}
                <a className="link" href={hrefFor({ name: "files", path: bad.path })}>
                  Open the file
                </a>
              </span>
            </li>
          ))}
        </ul>

        <section className="agents-editor card">
          {!draft && (
            <p className="hint">Pick an agent to read and change its file, or make a new one. An edit is the next turn's brief.</p>
          )}
          {draft && (
            <form
              className="rename-form"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              {/* Its face, large, and live as the name is typed: the name is
                  what the look comes from, so a new agent is met before it
                  is made. */}
              <div className="agents-editor-head">
                <Face seed={draft.name || "new"} size={56} mood={current ? moodFor(current) : "idle"} label={draft.name ? `${titleOf(draft.name)}'s face` : "A new agent's face"} />
                <div>
                  <strong>{draft.name ? titleOf(draft.name) : "A new agent"}</strong>
                  <span className="hint">{current ? current.description : "Its colour, shape and eyes come from its name."}</span>
                </div>
              </div>
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
                  rows={12}
                  value={draft.brief}
                  placeholder="You watch one listing for the owner…"
                  onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
                />
                <span className="hint">Its standing instructions, in the second person: what it is for, how to do the work, when to tell you.</span>
              </label>
              <div className="agents-fields">
                <label className="kos-field">
                  <span className="kos-field-label">Tools</span>
                  <input
                    className="kos-input"
                    value={draft.tools}
                    placeholder="all"
                    onChange={(e) => setDraft({ ...draft, tools: e.target.value })}
                  />
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
                  <input
                    className="kos-input"
                    value={draft.schedule}
                    placeholder="0 9 * * 1"
                    onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}
                  />
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
              <div className="rename-actions agents-actions">
                <button type="submit" className="btn btn--primary" disabled={busy || !draft.name.trim() || !draft.description.trim() || !draft.brief.trim()}>
                  {busy ? "Saving…" : isNew ? "Make it" : "Save"}
                </button>
                {current && (
                  <button type="button" className="btn" disabled={busy} onClick={() => onOpenThread(current.conversationId)}>
                    Open thread
                  </button>
                )}
                {current?.job && (
                  <button type="button" className="btn" disabled={busy} title="Run its scheduled prompt now, in its own thread" onClick={runNow}>
                    Run now
                  </button>
                )}
                {current && (
                  <a className="btn" href={hrefFor({ name: "files", path: current.path })} title="The file itself">
                    File
                  </a>
                )}
                {current && (
                  <button type="button" className="btn btn--danger" disabled={busy} onClick={remove}>
                    {confirmDelete ? "Delete for good" : "Delete"}
                  </button>
                )}
                <button type="button" className="btn" disabled={busy} onClick={() => onOpen()}>
                  Close
                </button>
              </div>
              {current && confirmDelete && (
                <p className="hint">Its file and its schedule go; its thread stays as an ordinary chat you can keep or delete.</p>
              )}
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
