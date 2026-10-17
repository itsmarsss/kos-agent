import { useCallback, useEffect, useState, type ReactElement } from "react";

import { AgentEditor, titleOf } from "./AgentEditor.js";
import { api, type AgentInfo, type InvalidAgent } from "./api.js";
import { Face, moodOf } from "./Face.js";
import { Modal } from "./Modal.js";
import { hrefFor } from "./routes.js";

/**
 * The standing agents, each with what it is up to.
 *
 * An agent is a file under agents/, and KOS makes them from a request. This
 * list is where the owner sees them all at once: the face, what it is for,
 * what it last said or is doing now, and when it runs next. A row opens the
 * agent's own page, its thread in the middle and its file beside it, so
 * the Chats tab stays the owner's own chats.
 */

export interface AgentsPageProps {
  /** "new" opens the editor for a blank agent. */
  open?: string;
  onOpen: (agent?: string) => void;
  onNotice: (text: string) => void;
  /** Something changed that the rest of the app lists: a thread, a job. */
  onChanged: () => void;
}

const POLL_MS = 5000;

function ago(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

/** One line on what it is up to: doing now beats said last. */
export function upTo(a: AgentInfo): string {
  // A host from before the list said what an agent was up to sends no thread.
  const t = a.thread ?? { activity: "idle" as const, lastSaid: null, updatedAt: a.updatedAt, unread: false, id: a.conversationId };
  if (t.activity === "working") return "Working now…";
  if (t.activity === "needs-you") return "Waiting on you";
  if (t.activity === "error") return `Its last turn failed${t.lastError ? `: ${t.lastError}` : ""}`;
  if (t.lastSaid) return `“${t.lastSaid}” · ${ago(t.updatedAt)}`;
  return "Nothing said yet";
}

/** One line on when it runs. */
export function runsWhen(a: AgentInfo): string {
  if (!a.job) return "runs when dispatched or spoken to";
  if (!a.job.enabled) return `paused · ${a.job.schedule}`;
  const next = a.job.nextRunAt ? `next ${when(a.job.nextRunAt)}` : a.job.schedule;
  return a.job.lastRunAt ? `${next} · last run ${ago(a.job.lastRunAt)}` : `${next} · not run yet`;
}

export function AgentsPage({ open, onOpen, onNotice, onChanged }: AgentsPageProps): ReactElement {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [invalid, setInvalid] = useState<InvalidAgent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api.agents();
      setAgents(r.agents);
      setInvalid(r.invalid);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  // Polled, so a face changes as its thread does and a run shows up when it lands.
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="projects agents">
      <div className="projects-head">
        <h1>Agents</h1>
        <button type="button" className="btn btn--primary" onClick={() => onOpen("new")}>
          New agent
        </button>
      </div>
      <p className="hint">
        A standing agent is a responsibility KOS keeps for you: a file under agents/ with a thread of its own and a schedule if it needs one.
        Ask KOS for one in a chat ("keep an eye on…", "every Saturday…"), or write one here. A row opens the agent's own page.
      </p>
      {error && <p className="ops-alert ops-alert--err">{error}</p>}

      <Modal open={open === "new"} title="New agent" onClose={() => onOpen()}>
        <AgentEditor
          onSaved={(agent) => {
            onNotice(`Made ${agent.name}`);
            onChanged();
            onOpen(agent.name);
          }}
          onCancel={() => onOpen()}
        />
      </Modal>

      <ul className="agents-list agents-list--index">
        {agents === null && !error && <li className="hint">Loading…</li>}
        {agents?.length === 0 && <li className="hint">None yet. Ask KOS to keep something up for you, or make one with New agent.</li>}
        {agents?.map((a) => (
          <li key={a.name}>
            <button type="button" className="agents-row" onClick={() => onOpen(a.name)}>
              <span className="agents-row-top">
                <span className="agents-row-who">
                  <Face seed={a.name} look={a.face ?? {}} size={30} mood={moodOf(a.thread?.activity, { paused: Boolean(a.job && !a.job.enabled) })} />
                  <span className="card-name">
                    {titleOf(a.name)}
                    {a.thread?.unread && <span className="unread-dot" aria-label="unread" />}
                  </span>
                </span>
                <span className="chats-badge">{a.job ? (a.job.enabled ? "scheduled" : "paused") : "on request"}</span>
              </span>
              <span className="agents-row-desc">{a.description}</span>
              <span className={`agents-row-upto is-${a.thread?.activity ?? "idle"}`}>{upTo(a)}</span>
              <span className="agents-row-meta">{runsWhen(a)}</span>
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
    </div>
  );
}
