import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

import { AgentEditor, titleOf } from "./AgentEditor.js";
import { api, type AgentInfo, type DirEntry } from "./api.js";
import { describeCron } from "./CronEditor.js";
import { Face, lookOf, moodOf } from "./Face.js";
import { Modal } from "./Modal.js";
import { Card, Pill, Tag } from "./kit.js";
import { hrefFor } from "./routes.js";
import { WEEK, agoWords, inWords, runDays, sizeWords } from "./schedulewords.js";

/**
 * The column beside a standing agent's thread: who it is, how it is doing,
 * when it runs, what it may reach, and what is in its folder. The thread
 * is where the agent is talked to; this is where it is kept. The column
 * takes the agent's own colour, so each one's page is its own.
 */

export interface AgentPanelProps {
  name: string;
  onOpenFile: (path: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (text: string) => void;
  /** The agent was removed; the page it sat on has nothing left to show. */
  onRemoved: () => void;
  hidden?: boolean;
}

const POLL_MS = 5000;

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** How the agent is doing, in a line, with a tone for the dot beside it. */
export function stateOf(a: AgentInfo, paused: boolean): { tone: "working" | "needs-you" | "error" | "asleep" | "idle"; text: string } {
  const t = a.thread;
  if (t?.activity === "working") return { tone: "working", text: "Working now" };
  if (t?.activity === "needs-you") return { tone: "needs-you", text: "Waiting on you" };
  if (t?.activity === "error") return { tone: "error", text: `Last turn failed${t.lastError ? `: ${t.lastError}` : ""}` };
  if (paused) return { tone: "asleep", text: "Asleep, its schedule is paused" };
  if (t?.lastSaid) return { tone: "idle", text: `Quiet, last spoke ${agoWords(t.updatedAt)}` };
  return { tone: "idle", text: "Quiet, nothing said yet" };
}

/** A small mark for a file row: its extension, or a slash for a folder. */
function glyphOf(e: DirEntry): string {
  if (e.kind === "dir") return "/";
  const dot = e.name.lastIndexOf(".");
  return dot > 0 ? e.name.slice(dot + 1).slice(0, 4) : "·";
}

/** agent.md first, then folders, then files by name. */
function byPlace(a: DirEntry, b: DirEntry): number {
  if (a.name === "agent.md") return -1;
  if (b.name === "agent.md") return 1;
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function AgentPanel({ name, onOpenFile, onChanged, onError, onNotice, onRemoved, hidden = false }: AgentPanelProps): ReactElement {
  const [agent, setAgent] = useState<AgentInfo | null | undefined>(undefined);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [invalidReason, setInvalidReason] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api.agents();
      const found = r.agents.find((a) => a.name === name) ?? null;
      setAgent(found);
      setInvalidReason(r.invalid.find((i) => i.name === name)?.reason ?? null);
      if (found) {
        const listed = await api.files(found.folder).catch(() => ({ entries: [] as DirEntry[] }));
        setEntries([...listed.entries].sort(byPlace));
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [name, onError]);

  useEffect(() => {
    setAgent(undefined);
    setConfirmDelete(false);
  }, [name]);

  useEffect(() => {
    if (hidden) return;
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, hidden]);

  const run = async (work: () => Promise<void>, done?: string): Promise<void> => {
    setBusy(true);
    try {
      await work();
      await load();
      onChanged();
      if (done) onNotice(done);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (agent === undefined) {
    return (
      <aside className="project-panel agent-panel" aria-hidden={hidden}>
        <p className="ops-muted">Loading…</p>
      </aside>
    );
  }
  if (agent === null) {
    return (
      <aside className="project-panel agent-panel" aria-hidden={hidden}>
        <p className="ops-alert ops-alert--err" role="alert">
          {invalidReason ? `agents/${name}/agent.md does not read as an agent: ${invalidReason}.` : `There is no agent called ${name}.`}
        </p>
        {invalidReason && (
          <button type="button" className="btn btn--sm" onClick={() => onOpenFile(`agents/${name}/agent.md`)}>
            Open the file
          </button>
        )}
      </aside>
    );
  }

  const paused = Boolean(agent.job && !agent.job.enabled);
  const state = stateOf(agent, paused);
  const hue = lookOf(agent.name, agent.face ?? {}).hue;
  const days = agent.job ? runDays(agent.job.schedule) : null;
  const title = titleOf(agent.name);

  return (
    <aside className="project-panel agent-panel" aria-label={`${title}, the agent`} aria-hidden={hidden} style={{ "--blob-h": String(hue) } as CSSProperties}>
      {/* Who it is: its face on a glow of its own colour, and how it is doing. */}
      <header className="hero">
        <Face seed={agent.name} look={agent.face ?? {}} size={72} mood={moodOf(agent.thread?.activity, { paused })} />
        <h2>{title}</h2>
        <p className="hero-desc">{agent.description}</p>
        <span className={`hero-state is-${state.tone}`}>
          <span className="hero-dot" aria-hidden="true" />
          {state.text}
        </span>
      </header>

      <Card title="Schedule" pill={agent.job ? <Pill tone={paused ? "warn" : "ok"}>{paused ? "paused" : "on"}</Pill> : undefined}>
        {agent.job ? (
          <>
            <p className="agent-when">{describeCron(agent.job.schedule) ?? agent.job.schedule}</p>
            <code className="agent-cron">{agent.job.schedule}</code>
            {days && (
              <div className="agent-week" aria-label="Days it runs">
                {WEEK.map((d, i) => (
                  <span key={i} className={days.has(i) ? "is-on" : ""} aria-label={days.has(i) ? "runs" : "rests"}>
                    {d}
                  </span>
                ))}
              </div>
            )}
            <ul className="agent-kv">
              <li>
                <span>Next run</span>
                <b>{agent.job.nextRunAt ? inWords(agent.job.nextRunAt) : paused ? "when resumed" : "on its schedule"}</b>
                {agent.job.nextRunAt && <span>{when(agent.job.nextRunAt)}</span>}
              </li>
              <li>
                <span>Last run</span>
                <b>{agent.job.lastRunAt ? agoWords(agent.job.lastRunAt) : "not yet"}</b>
                {agent.job.lastRunAt && <span>{when(agent.job.lastRunAt)}</span>}
              </li>
            </ul>
            <div className="agent-acts">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={busy}
                title="Run its scheduled prompt now, in its thread"
                onClick={() => void run(() => api.runAgent(agent.name).then(() => undefined), `${title} is running`)}
              >
                Run now
              </button>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void run(() => api.setCronEnabled(agent.job!.id, paused).then(() => undefined), paused ? "Resumed" : "Paused")}>
                {paused ? "Resume" : "Pause"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="agent-when">On request</p>
            <p className="hint">It works when you speak to it or KOS dispatches it. Edit to give it a schedule.</p>
          </>
        )}
      </Card>

      <Card title="Reach">
        <div className="tags">
          {agent.tools?.length ? (
            agent.tools.map((t) => (
              <Tag key={t} mono title="A tool family it may use">
                {t}
              </Tag>
            ))
          ) : (
            <Tag title="Every tool KOS has">Full toolkit</Tag>
          )}
          <Tag title={agent.memory === "own" ? "What it remembers is its own" : "It shares memory with the project it is in, or the global pool"}>{agent.memory === "own" ? "Own memory" : "Shared memory"}</Tag>
          <Tag title="Which model class answers">{agent.task === "cheap" ? "Cheap model" : "Reasoning model"}</Tag>
        </div>
      </Card>

      <Card
        title="Folder"
        count={entries.length}
        action={
          <button type="button" className="link" onClick={() => onOpenFile(agent.folder)} title="Its folder on the Files page">
            Open in Files →
          </button>
        }
      >
        {/* Its own place: agent.md says what it is, and the rest is what it has made. */}
        <ul className="agent-files">
          {entries.map((e) => (
            <li key={e.path}>
              <a
                className="agent-file"
                href={hrefFor({ name: "files", path: e.path })}
                onClick={(ev) => {
                  ev.preventDefault();
                  onOpenFile(e.path);
                }}
              >
                <span className="agent-file-glyph" aria-hidden="true">
                  {glyphOf(e)}
                </span>
                <span className="agent-file-name">{e.kind === "dir" ? `${e.name}/` : e.name}</span>
                {e.name === "agent.md" ? <span className="agent-file-tag">what it is</span> : e.kind === "file" && <span className="agent-file-meta">{sizeWords(e.size)}</span>}
              </a>
            </li>
          ))}
          {entries.length === 0 && <li className="hint">Nothing in agents/{agent.name}/ yet.</li>}
        </ul>
      </Card>

      <footer className="agent-foot">
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className={`btn btn--sm ${confirmDelete ? "btn--danger" : "btn--danger-ghost"}`}
          disabled={busy}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            void run(async () => {
              await api.deleteAgent(agent.name);
            }, `Removed ${agent.name}; its thread stays as a chat`).then(onRemoved);
          }}
        >
          {confirmDelete ? "Delete for good" : "Delete"}
        </button>
      </footer>
      {confirmDelete && <p className="hint">Its file and its schedule go; its thread stays as an ordinary chat, and its folder stays if it made anything.</p>}

      <Modal open={editing} title={`Edit ${title}`} onClose={() => setEditing(false)}>
        {editing && (
          <AgentEditor
            initial={agent}
            onSaved={(saved) => {
              setEditing(false);
              setAgent(saved);
              onChanged();
              onNotice(`Saved ${saved.name}`);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </Modal>
    </aside>
  );
}
