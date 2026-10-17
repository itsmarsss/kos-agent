import { useCallback, useEffect, useState, type ReactElement } from "react";

import { AgentEditor, titleOf } from "./AgentEditor.js";
import { api, type AgentInfo } from "./api.js";
import { Face, moodOf } from "./Face.js";
import { Modal } from "./Modal.js";
import { PanelSection } from "./PanelSection.js";

/**
 * The column beside a standing agent's thread: what it is, when it runs,
 * what it may reach, and the file itself. The thread is where the agent
 * is talked to; this is where it is kept.
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

function ago(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function AgentPanel({ name, onOpenFile, onChanged, onError, onNotice, onRemoved, hidden = false }: AgentPanelProps): ReactElement {
  const [agent, setAgent] = useState<AgentInfo | null | undefined>(undefined);
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
      <aside className="project-panel" aria-hidden={hidden}>
        <p className="ops-muted">Loading…</p>
      </aside>
    );
  }
  if (agent === null) {
    return (
      <aside className="project-panel" aria-hidden={hidden}>
        <p className="ops-alert ops-alert--err" role="alert">
          {invalidReason ? `agents/${name}.md does not read as an agent: ${invalidReason}.` : `There is no agent called ${name}.`}
        </p>
        {invalidReason && (
          <button type="button" className="btn btn--sm" onClick={() => onOpenFile(`agents/${name}.md`)}>
            Open the file
          </button>
        )}
      </aside>
    );
  }

  const paused = Boolean(agent.job && !agent.job.enabled);
  return (
    <aside className="project-panel" aria-label={`${titleOf(agent.name)}, the agent`} aria-hidden={hidden}>
      <div className="agent-panel-head">
        <Face seed={agent.name} size={44} mood={moodOf(agent.thread?.activity, { paused })} />
        <div>
          <strong>{titleOf(agent.name)}</strong>
          <span className="hint">{agent.description}</span>
        </div>
      </div>

      <PanelSection title="Schedule">
        {agent.job ? (
          <ul className="agent-panel-lines">
            <li>
              <span className="ops-mono">{agent.job.schedule}</span>
              <span className="insp-meta">{paused ? "paused" : "on"}</span>
            </li>
            <li>
              <span>Next run</span>
              <span className="insp-meta">{agent.job.nextRunAt ? when(agent.job.nextRunAt) : paused ? "when resumed" : "not scheduled"}</span>
            </li>
            <li>
              <span>Last run</span>
              <span className="insp-meta">{agent.job.lastRunAt ? ago(agent.job.lastRunAt) : "not yet"}</span>
            </li>
          </ul>
        ) : (
          <p className="hint">No schedule: it works when dispatched or spoken to. Edit the file to give it one.</p>
        )}
        <div className="agent-panel-acts">
          {agent.job && (
            <button type="button" className="btn btn--sm" disabled={busy} title="Run its scheduled prompt now, in its thread" onClick={() => void run(() => api.runAgent(agent.name).then(() => undefined), `${titleOf(agent.name)} is running`)}>
              Run now
            </button>
          )}
          {agent.job && (
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => void run(() => api.setCronEnabled(agent.job!.id, paused).then(() => undefined), paused ? "Resumed" : "Paused")}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Reach">
        <ul className="agent-panel-lines">
          <li>
            <span>Tools</span>
            <span className="insp-meta">{agent.tools?.length ? agent.tools.join(", ") : "all"}</span>
          </li>
          <li>
            <span>Memory</span>
            <span className="insp-meta">{agent.memory === "own" ? "its own" : "shared"}</span>
          </li>
          <li>
            <span>Model</span>
            <span className="insp-meta">{agent.task ?? "reasoning"}</span>
          </li>
        </ul>
      </PanelSection>

      <PanelSection title="File">
        <p className="hint ops-mono">{agent.path}</p>
        <div className="agent-panel-acts">
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="btn btn--sm" onClick={() => onOpenFile(agent.path)}>
            Open in Files
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
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
        </div>
        {confirmDelete && <p className="hint">Its file and its schedule go; its thread stays as an ordinary chat you can keep or delete.</p>}
      </PanelSection>

      <Modal open={editing} title={`Edit ${titleOf(agent.name)}`} onClose={() => setEditing(false)}>
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
