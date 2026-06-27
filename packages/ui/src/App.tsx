import { useCallback, useEffect, useState } from "react";

import {
  api,
  type CronJob,
  type PendingAction,
  type Project,
  type RunRecord,
  type Status,
} from "./api.js";
import { ErrorBoundary } from "./widgets/ErrorBoundary.js";

/**
 * The dashboard: the one fixed page the developer owns (the trunk). It shows the
 * state of KOS plus controls, never project content (that lives in agent-built
 * pages). Status strip, pending approvals, projects index, recent activity,
 * upcoming crons, failed runs, and controls (kill switch + prompt box).
 */
export function App(): React.ReactElement {
  const [status, setStatus] = useState<Status | null>(null);
  const [approvals, setApprovals] = useState<PendingAction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [failed, setFailed] = useState<RunRecord[]>([]);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");

  const refresh = useCallback(async () => {
    const [s, a, p, c, f] = await Promise.all([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.failed(),
    ]);
    setStatus(s);
    setApprovals(a);
    setProjects(p);
    setCrons(c);
    setFailed(f);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const decide = async (id: number, approved: boolean): Promise<void> => {
    await (approved ? api.approve(id) : api.deny(id));
    await refresh();
  };

  const toggleKill = async (): Promise<void> => {
    if (!status) return;
    await api.setKill(!status.halted);
    await refresh();
  };

  const send = async (): Promise<void> => {
    if (prompt.trim() === "") return;
    const res = await api.message(prompt);
    setReply(res.reply);
    setPrompt("");
    await refresh();
  };

  return (
    <ErrorBoundary label="dashboard">
      <main className="kos-dashboard">
        <h1>K-OS</h1>

        <section className="kos-status-strip">
          {status ? (
            <>
              <span>{status.halted ? "HALTED" : "running"}</span>
              <span>queue {status.queueDepth}</span>
              <span>crons {status.crons}</span>
              <span>pending {status.pendingApprovals}</span>
            </>
          ) : (
            <span>loading…</span>
          )}
        </section>

        <section>
          <h2>Pending approvals</h2>
          {approvals.length === 0 && <p>None.</p>}
          {approvals.map((a) => (
            <div key={a.id} className="kos-approval">
              <code>
                #{a.id} {a.tool} {a.args}
              </code>
              <button onClick={() => void decide(a.id, true)}>Approve</button>
              <button onClick={() => void decide(a.id, false)}>Deny</button>
            </div>
          ))}
        </section>

        <section>
          <h2>Projects</h2>
          {projects.length === 0 && <p>No projects yet.</p>}
          <ul>
            {projects.map((p) => (
              <li key={p.slug}>
                {p.name} <em>({p.type})</em> — {p.status}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Upcoming crons</h2>
          <ul>
            {crons.map((c) => (
              <li key={c.id}>
                {c.name} [{c.schedule}] {c.type}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Failed runs</h2>
          {failed.length === 0 && <p>None.</p>}
          <ul>
            {failed.map((r) => (
              <li key={r.id}>
                {r.kind}: {r.error}
              </li>
            ))}
          </ul>
        </section>

        <section className="kos-controls">
          <h2>Controls</h2>
          <button onClick={() => void toggleKill()}>
            {status?.halted ? "Resume" : "Halt"}
          </button>
          <div className="kos-prompt">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Message KOS…"
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
            />
            <button onClick={() => void send()}>Send</button>
          </div>
          {reply && <p className="kos-reply">{reply}</p>}
        </section>
      </main>
    </ErrorBoundary>
  );
}
