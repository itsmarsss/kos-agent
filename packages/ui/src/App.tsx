import { useCallback, useEffect, useState } from "react";

import {
  api,
  type CronJob,
  type PagePayload,
  type PageSummary,
  type PendingAction,
  type Project,
  type RunRecord,
  type Status,
} from "./api.js";
import { ErrorBoundary } from "./widgets/ErrorBoundary.js";
import { PageRenderer } from "./widgets/PageRenderer.js";

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
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [view, setView] = useState<"home" | "page">("home");
  const [activePage, setActivePage] = useState<PagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, a, p, c, f, pg] = await Promise.all([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.failed(),
      api.pages(),
    ]);
    setStatus(s);
    setApprovals(a);
    setProjects(p);
    setCrons(c);
    setFailed(f);
    setPages(pg);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Hash routing: #/page/<id>
  useEffect(() => {
    const sync = (): void => {
      const hash = window.location.hash.replace(/^#/, "");
      const m = hash.match(/^\/page\/([^/]+)$/);
      if (m?.[1]) {
        setView("page");
        setPageError(null);
        void api
          .page(decodeURIComponent(m[1]))
          .then((payload) => setActivePage(payload))
          .catch((err: unknown) => {
            setActivePage(null);
            setPageError(err instanceof Error ? err.message : String(err));
          });
      } else {
        setView("home");
        setActivePage(null);
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

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

  const openPage = (id: string): void => {
    window.location.hash = `#/page/${encodeURIComponent(id)}`;
  };

  if (view === "page") {
    return (
      <ErrorBoundary label="page">
        <main className="kos-dashboard">
          <p>
            <a
              href="#/"
              onClick={(e) => {
                e.preventDefault();
                window.location.hash = "";
              }}
            >
              ← Dashboard
            </a>
          </p>
          {pageError && <p role="alert">{pageError}</p>}
          {activePage && (
            <PageRenderer spec={activePage.spec} data={activePage.data} />
          )}
          {!activePage && !pageError && <p>Loading page…</p>}
        </main>
      </ErrorBoundary>
    );
  }

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
              <button type="button" onClick={() => void decide(a.id, true)}>
                Approve
              </button>
              <button type="button" onClick={() => void decide(a.id, false)}>
                Deny
              </button>
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
                {pages
                  .filter((pg) => pg.projectSlug === p.slug)
                  .map((pg) => (
                    <button
                      key={pg.id}
                      type="button"
                      className="kos-link-btn"
                      onClick={() => openPage(pg.id)}
                    >
                      {pg.title}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Pages</h2>
          {pages.length === 0 && <p>No agent pages yet.</p>}
          <ul>
            {pages.map((pg) => (
              <li key={pg.id}>
                <button type="button" onClick={() => openPage(pg.id)}>
                  {pg.title}
                </button>{" "}
                <em>({pg.projectSlug})</em>
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
                {!c.enabled ? " (disabled)" : ""}
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
          <button type="button" onClick={() => void toggleKill()}>
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
            <button type="button" onClick={() => void send()}>
              Send
            </button>
          </div>
          {reply && <p className="kos-reply">{reply}</p>}
        </section>
      </main>
    </ErrorBoundary>
  );
}
