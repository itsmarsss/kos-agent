import { useCallback, useEffect, useState } from "react";
import { summarizeAction } from "@kos/shared";

import {
  api,
  type AuditRecord,
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

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Control-tower dashboard: status, approvals, projects, pages, crons, failures,
 * prompt box. Project content lives one click away on agent page specs.
 */
export function App(): React.ReactElement {
  const [status, setStatus] = useState<Status | null>(null);
  const [approvals, setApprovals] = useState<PendingAction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [failed, setFailed] = useState<RunRecord[]>([]);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [activity, setActivity] = useState<AuditRecord[]>([]);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [view, setView] = useState<"home" | "page">("home");
  const [activePage, setActivePage] = useState<PagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, a, p, c, f, pg, act] = await Promise.all([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.failed(),
      api.pages(),
      api.activity().catch(() => ({ tools: [] as AuditRecord[], runs: [] })),
    ]);
    setStatus(s);
    setApprovals(a);
    setProjects(p);
    setCrons(c);
    setFailed(f);
    setPages(pg);
    setActivity(act.tools.slice(0, 12));
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

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
    if (prompt.trim() === "" || sending) return;
    setSending(true);
    try {
      const res = await api.message(prompt);
      setReply(res.reply);
      setPrompt("");
      await refresh();
    } catch (err) {
      setReply(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const openPage = (id: string): void => {
    window.location.hash = `#/page/${encodeURIComponent(id)}`;
  };

  if (view === "page") {
    return (
      <ErrorBoundary label="page">
        <main className="kos-dashboard">
          <a
            className="kos-back"
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              window.location.hash = "";
            }}
          >
            ← Dashboard
          </a>
          {pageError && (
            <p className="kos-page-invalid" role="alert">
              {pageError}
            </p>
          )}
          {activePage && (
            <PageRenderer spec={activePage.spec} data={activePage.data} />
          )}
          {!activePage && !pageError && <p className="kos-empty">Loading page…</p>}
        </main>
      </ErrorBoundary>
    );
  }

  const running = status && !status.halted;
  const discordOn = status?.discord === true;

  return (
    <ErrorBoundary label="dashboard">
      <main className="kos-dashboard">
        <header className="kos-header">
          <div className="kos-brand">
            <h1>
              K<span>-OS</span>
            </h1>
            <p>Control tower · one workspace, many channels</p>
          </div>
          <button
            type="button"
            className={`kos-btn ${status?.halted ? "kos-btn--ok" : "kos-btn--danger"}`}
            onClick={() => void toggleKill()}
          >
            {status?.halted ? "Resume" : "Halt"}
          </button>
        </header>

        <section className="kos-status-strip" aria-label="Status">
          {!status && <span className="kos-pill">loading…</span>}
          {status && (
            <>
              <span className={`kos-pill ${running ? "kos-pill--ok" : "kos-pill--danger"}`}>
                {status.halted ? "HALTED" : "running"}
              </span>
              <span className={`kos-pill ${discordOn ? "kos-pill--ok" : ""}`}>
                discord {discordOn ? "on" : "off"}
              </span>
              <span className="kos-pill">
                <strong>queue</strong> {status.queueDepth}
              </span>
              <span className="kos-pill">
                <strong>crons</strong> {status.crons}
              </span>
              <span
                className={`kos-pill ${status.pendingApprovals > 0 ? "kos-pill--warn" : ""}`}
              >
                <strong>pending</strong> {status.pendingApprovals}
              </span>
              <span className="kos-pill">
                <strong>projects</strong> {status.projects ?? projects.length}
              </span>
            </>
          )}
        </section>

        <div className="kos-grid">
          <section className="kos-card kos-card--wide">
            <h2>Pending approvals</h2>
            {approvals.length === 0 && <p className="kos-empty">None right now.</p>}
            {approvals.map((a) => (
              <div key={a.id} className="kos-approval">
                <div className="kos-approval-head">
                  <span className="kos-approval-title">
                    {summarizeAction(a.tool, a.args)}
                  </span>
                  <span className="kos-mono kos-meta">#{a.id}</span>
                </div>
                <div className="kos-meta">
                  <span className="kos-mono">{a.tool}</span>
                  {a.reason ? ` · ${a.reason}` : ""}
                  {a.requestedAt ? ` · ${timeAgo(a.requestedAt)}` : ""}
                </div>
                <div className="kos-approval-actions">
                  <button
                    type="button"
                    className="kos-btn kos-btn--ok"
                    onClick={() => void decide(a.id, true)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="kos-btn kos-btn--danger"
                    onClick={() => void decide(a.id, false)}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="kos-card">
            <h2>Projects</h2>
            {projects.length === 0 && <p className="kos-empty">No projects yet.</p>}
            <ul className="kos-list">
              {projects.map((p) => {
                const linked = pages.filter((pg) => pg.projectSlug === p.slug);
                return (
                  <li key={p.slug}>
                    <div>
                      <div>{p.name}</div>
                      <div className="kos-meta">
                        {p.type} · {p.status}
                        {linked.length > 0 && (
                          <>
                            {" · "}
                            {linked.map((pg) => (
                              <button
                                key={pg.id}
                                type="button"
                                className="kos-link-btn"
                                onClick={() => openPage(pg.id)}
                              >
                                {pg.title}
                              </button>
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                    <span className="kos-mono kos-meta">{p.slug}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="kos-card">
            <h2>Pages</h2>
            {pages.length === 0 && <p className="kos-empty">No agent pages yet.</p>}
            <ul className="kos-list">
              {pages.map((pg) => (
                <li key={pg.id}>
                  <button
                    type="button"
                    className="kos-link-btn"
                    onClick={() => openPage(pg.id)}
                  >
                    {pg.title}
                  </button>
                  <span className="kos-meta">{pg.projectSlug}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="kos-card">
            <h2>Crons</h2>
            {crons.length === 0 && <p className="kos-empty">No scheduled jobs.</p>}
            <ul className="kos-list">
              {crons.map((c) => (
                <li key={c.id}>
                  <div>
                    <div>{c.name}</div>
                    <div className="kos-meta kos-mono">
                      {c.schedule} · {c.type}
                      {!c.enabled ? " · disabled" : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="kos-card">
            <h2>Failed runs</h2>
            {failed.length === 0 && <p className="kos-empty">None.</p>}
            <ul className="kos-list">
              {failed.map((r) => (
                <li key={r.id}>
                  <div>
                    <div>{r.kind}</div>
                    <div className="kos-meta">{r.error}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="kos-card kos-card--wide">
            <h2>Recent tool calls</h2>
            {activity.length === 0 && <p className="kos-empty">Quiet so far.</p>}
            <ul className="kos-list">
              {activity.map((t) => (
                <li key={t.id}>
                  <div>
                    <span className="kos-mono">{t.tool}</span>
                    {t.isError ? (
                      <span className="kos-meta"> · error</span>
                    ) : null}
                  </div>
                  <span className="kos-meta">{timeAgo(t.createdAt)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className={`kos-card kos-card--wide ${sending ? "kos-sending" : ""}`}>
            <h2>Message KOS</h2>
            <div className="kos-prompt">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Same session as Discord…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void send();
                }}
              />
              <button
                type="button"
                className="kos-btn kos-btn--primary"
                onClick={() => void send()}
              >
                {sending ? "…" : "Send"}
              </button>
            </div>
            {reply && <p className="kos-reply">{reply}</p>}
          </section>
        </div>
      </main>
    </ErrorBoundary>
  );
}
