import { useCallback, useEffect, useMemo, useState } from "react";
import { summarizeAction } from "@kos/shared";

import {
  api,
  type AuditRecord,
  type CronJob,
  type FactRow,
  type PagePayload,
  type PageSummary,
  type PendingAction,
  type Project,
  type RunRecord,
  type Status,
} from "./api.js";
import { Inspector, type InspectTarget } from "./Inspector.js";
import { ErrorBoundary } from "./widgets/ErrorBoundary.js";
import { PageRenderer } from "./widgets/PageRenderer.js";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function preview(text: string, n = 48): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

type Toast = { kind: "ok" | "err"; text: string } | null;

/**
 * Ops dashboard: console + inventory previews; click any row to inspect fully.
 */
export function App(): React.ReactElement {
  const [status, setStatus] = useState<Status | null>(null);
  const [approvals, setApprovals] = useState<PendingAction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [failed, setFailed] = useState<RunRecord[]>([]);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [activity, setActivity] = useState<AuditRecord[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [prompt, setPrompt] = useState("");
  const [thread, setThread] = useState<
    Array<{ role: "you" | "kos"; text: string }>
  >([]);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [view, setView] = useState<"home" | "page">("home");
  const [activePage, setActivePage] = useState<PagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);

  const flash = (kind: "ok" | "err", text: string): void => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  };

  const refresh = useCallback(async () => {
    const [s, a, p, c, f, pg, act, mem] = await Promise.all([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.failed(),
      api.pages(),
      api.activity().catch(() => ({ tools: [] as AuditRecord[], runs: [] })),
      api.memory().catch(() => ({ facts: [] as FactRow[] })),
    ]);
    setStatus(s);
    setApprovals(a);
    setProjects(p);
    setCrons(c);
    setFailed(f);
    setPages(pg);
    setActivity(act.tools.slice(0, 40));
    setFacts((mem.facts ?? []).slice(0, 30));
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

  const pagesByProject = useMemo(() => {
    const map = new Map<string, PageSummary[]>();
    for (const pg of pages) {
      const list = map.get(pg.projectSlug) ?? [];
      list.push(pg);
      map.set(pg.projectSlug, list);
    }
    return map;
  }, [pages]);

  const filteredProjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        p.type.toLowerCase().includes(q) ||
        (p.module ?? "").toLowerCase().includes(q),
    );
  }, [projects, filter]);

  const decide = async (id: number, approved: boolean): Promise<void> => {
    setBusy(approved ? `approving #${id}` : `denying #${id}`);
    try {
      const res = await (approved ? api.approve(id) : api.deny(id));
      if (res.reply) {
        setThread((t) => [...t, { role: "kos", text: res.reply! }]);
      }
      flash("ok", approved ? `Approved #${id}` : `Denied #${id}`);
      await refresh();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleKill = async (): Promise<void> => {
    if (!status) return;
    setBusy(status.halted ? "resuming" : "halting");
    try {
      await api.setKill(!status.halted);
      await refresh();
      flash("ok", status.halted ? "Resumed" : "Halted");
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const doSnapshot = async (): Promise<void> => {
    setBusy("snapshot");
    try {
      const res = await api.snapshot("dashboard snapshot");
      flash(
        "ok",
        res.sha ? `Snapshot ${res.sha.slice(0, 10)}` : "Nothing to snapshot",
      );
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const doClear = async (): Promise<void> => {
    setBusy("clear session");
    try {
      const res = await api.clear();
      setThread([]);
      flash("ok", `Cleared ${res.cleared}`);
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const copyWorkspace = async (): Promise<void> => {
    const ws = status?.workspace ?? "";
    if (!ws) return;
    try {
      await navigator.clipboard.writeText(ws);
      flash("ok", "Workspace path copied");
    } catch {
      flash("err", ws);
    }
  };

  const send = async (): Promise<void> => {
    const text = prompt.trim();
    if (text === "" || sending) return;
    setSending(true);
    setThread((t) => [...t, { role: "you", text }]);
    setPrompt("");
    try {
      const res = await api.message(text);
      setThread((t) => [...t, { role: "kos", text: res.reply || "(no reply)" }]);
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setThread((t) => [...t, { role: "kos", text: `Error: ${msg}` }]);
      flash("err", msg);
    } finally {
      setSending(false);
    }
  };

  const openPage = (id: string): void => {
    setInspect(null);
    window.location.hash = `#/page/${encodeURIComponent(id)}`;
  };

  if (view === "page") {
    return (
      <ErrorBoundary label="page">
        <main className="ops">
          <a
            className="ops-back"
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              window.location.hash = "";
            }}
          >
            ← Back to ops
          </a>
          {pageError && (
            <p className="ops-alert ops-alert--err" role="alert">
              {pageError}
            </p>
          )}
          {activePage && (
            <PageRenderer spec={activePage.spec} data={activePage.data} />
          )}
          {!activePage && !pageError && <p className="ops-muted">Loading…</p>}
        </main>
      </ErrorBoundary>
    );
  }

  const running = status && !status.halted;

  return (
    <ErrorBoundary label="dashboard">
      <main className="ops">
        {toast && (
          <div className={`ops-toast ops-toast--${toast.kind}`} role="status">
            {toast.text}
          </div>
        )}

        <Inspector
          target={inspect}
          onClose={() => setInspect(null)}
          onOpenPage={openPage}
        />

        <header className="ops-top">
          <div className="ops-top-left">
            <div className="ops-logo">
              K<span>-OS</span>
            </div>
            <button
              type="button"
              className="ops-path"
              title="Copy workspace path"
              onClick={() => void copyWorkspace()}
            >
              {status?.workspace ?? "…"}
            </button>
          </div>
          <div className="ops-top-actions">
            {busy && <span className="ops-busy">{busy}…</span>}
            <button type="button" className="ops-btn" onClick={() => void refresh()}>
              Refresh
            </button>
            <button type="button" className="ops-btn" onClick={() => void doSnapshot()}>
              Snapshot
            </button>
            <button type="button" className="ops-btn" onClick={() => void doClear()}>
              Clear chat
            </button>
            <button
              type="button"
              className={`ops-btn ${status?.halted ? "ops-btn--ok" : "ops-btn--danger"}`}
              onClick={() => void toggleKill()}
            >
              {status?.halted ? "Resume" : "Halt"}
            </button>
          </div>
        </header>

        <div className="ops-metrics" aria-label="Status">
          <Metric
            label="State"
            value={status ? (status.halted ? "HALTED" : "running") : "…"}
            tone={running ? "ok" : status?.halted ? "danger" : "muted"}
          />
          <Metric
            label="Discord"
            value={status?.discord ? "on" : "off"}
            tone={status?.discord ? "ok" : "muted"}
          />
          <Metric label="Queue" value={String(status?.queueDepth ?? "–")} />
          <Metric
            label="Pending"
            value={String(status?.pendingApprovals ?? "–")}
            tone={(status?.pendingApprovals ?? 0) > 0 ? "warn" : "muted"}
          />
          <Metric label="Crons" value={String(status?.crons ?? "–")} />
          <Metric label="Projects" value={String(projects.length)} />
          <Metric label="PID" value={status?.pid ? String(status.pid) : "–"} />
        </div>

        {approvals.length > 0 && (
          <section className="ops-approvals" aria-label="Pending approvals">
            <div className="ops-section-head">
              <h2>Approvals</h2>
              <span className="ops-badge ops-badge--warn">{approvals.length}</span>
            </div>
            {approvals.map((a) => (
              <div key={a.id} className="ops-approval-row">
                <div className="ops-approval-main">
                  <div className="ops-approval-title">
                    <span className="ops-mono">#{a.id}</span>{" "}
                    {summarizeAction(a.tool, a.args)}
                  </div>
                  <div className="ops-muted">
                    <span className="ops-mono">{a.tool}</span>
                    {a.reason ? ` · ${a.reason}` : ""}
                    {a.requestedAt ? ` · ${timeAgo(a.requestedAt)} ago` : ""}
                  </div>
                </div>
                <div className="ops-approval-btns">
                  <button
                    type="button"
                    className="ops-btn ops-btn--ok"
                    onClick={() => void decide(a.id, true)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="ops-btn ops-btn--danger"
                    onClick={() => void decide(a.id, false)}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        <div className="ops-split">
          <section className="ops-console" aria-label="Console">
            <div className="ops-section-head">
              <h2>Console</h2>
              <span className="ops-muted">same session as Discord</span>
            </div>

            <div className="ops-thread" aria-live="polite">
              {thread.length === 0 && (
                <p className="ops-muted ops-thread-empty">
                  Message KOS here. Click rows in tools / sidebar to inspect details.
                </p>
              )}
              {thread.map((m, i) => (
                <div
                  key={i}
                  className={`ops-msg ops-msg--${m.role === "you" ? "you" : "kos"}`}
                >
                  <div className="ops-msg-role">
                    {m.role === "you" ? "You" : "KOS"}
                  </div>
                  <div className="ops-msg-body">{m.text}</div>
                </div>
              ))}
            </div>

            <div className={`ops-composer ${sending ? "is-busy" : ""}`}>
              <textarea
                value={prompt}
                rows={3}
                placeholder="Ask KOS to list tonight, add a task, snapshot, …"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="ops-composer-bar">
                <span className="ops-muted">⌘/Ctrl+Enter to send</span>
                <button
                  type="button"
                  className="ops-btn ops-btn--primary"
                  onClick={() => void send()}
                  disabled={sending}
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </div>

            <div className="ops-section-head ops-section-head--sub">
              <h2>Recent tools</h2>
              <span className="ops-muted">click to inspect</span>
            </div>
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Preview</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.length === 0 && (
                    <tr>
                      <td colSpan={4} className="ops-muted">
                        No tool calls yet
                      </td>
                    </tr>
                  )}
                  {activity.map((t) => (
                    <tr
                      key={t.id}
                      className="ops-row-click"
                      onClick={() => setInspect({ kind: "tool", data: t })}
                    >
                      <td className="ops-mono">{t.tool}</td>
                      <td className="ops-muted">
                        {preview(summarizeAction(t.tool, t.args), 42)}
                      </td>
                      <td>
                        {t.isError ? (
                          <span className="ops-tag ops-tag--danger">error</span>
                        ) : (
                          <span className="ops-tag ops-tag--ok">ok</span>
                        )}
                      </td>
                      <td className="ops-muted">{timeAgo(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="ops-side" aria-label="Inventory">
            <section className="ops-panel">
              <div className="ops-section-head">
                <h2>Projects</h2>
                <input
                  className="ops-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  aria-label="Filter projects"
                />
              </div>
              {filteredProjects.length === 0 && (
                <p className="ops-muted">No projects.</p>
              )}
              <ul className="ops-nav">
                {filteredProjects.map((p) => {
                  const linked = pagesByProject.get(p.slug) ?? [];
                  return (
                    <li key={p.slug} className="ops-project">
                      <button
                        type="button"
                        className="ops-project-btn"
                        onClick={() =>
                          setInspect({
                            kind: "project",
                            data: p,
                            pages: linked,
                          })
                        }
                      >
                        <div className="ops-project-top">
                          <span className="ops-nav-title">{p.name}</span>
                          <span className={`ops-status ops-status--${p.status}`}>
                            {p.status}
                          </span>
                        </div>
                        <div className="ops-muted">
                          <span className="ops-mono">{p.slug}</span>
                          {" · "}
                          {p.type}
                          {p.module ? ` · ${p.module}` : ""}
                          {" · "}
                          {timeAgo(p.lastTouchedAt)} ago
                        </div>
                        {linked.length > 0 && (
                          <div className="ops-page-chips">
                            {linked.map((pg) => (
                              <span
                                key={pg.id}
                                className="ops-chip"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openPage(pg.id);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.stopPropagation();
                                    openPage(pg.id);
                                  }
                                }}
                                role="link"
                                tabIndex={0}
                              >
                                {pg.title}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="ops-panel">
              <div className="ops-section-head">
                <h2>Crons</h2>
                <span className="ops-muted">click</span>
              </div>
              {crons.length === 0 && <p className="ops-muted">None scheduled.</p>}
              <ul className="ops-dense">
                {crons.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="ops-dense-btn"
                      onClick={() => setInspect({ kind: "cron", data: c })}
                    >
                      <span>
                        {c.name}
                        {!c.enabled ? (
                          <span className="ops-tag ops-tag--muted"> off</span>
                        ) : null}
                      </span>
                      <span className="ops-mono ops-muted">{c.schedule}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="ops-panel">
              <div className="ops-section-head">
                <h2>Memory</h2>
                <span className="ops-muted">click</span>
              </div>
              {facts.length === 0 && (
                <p className="ops-muted">No durable facts yet.</p>
              )}
              <ul className="ops-dense">
                {facts.map((f, i) => (
                  <li key={`${f.key}-${i}`}>
                    <button
                      type="button"
                      className="ops-dense-btn"
                      onClick={() => setInspect({ kind: "fact", data: f })}
                    >
                      <span className="ops-mono">{f.key}</span>
                      <span className="ops-muted">{preview(f.value, 36)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {failed.length > 0 && (
              <section className="ops-panel ops-panel--danger">
                <div className="ops-section-head">
                  <h2>Failed runs</h2>
                  <span className="ops-badge ops-badge--danger">
                    {failed.length}
                  </span>
                </div>
                <ul className="ops-dense">
                  {failed.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="ops-dense-btn"
                        onClick={() => setInspect({ kind: "run", data: r })}
                      >
                        <span>{r.kind}</span>
                        <span className="ops-muted">
                          {preview(r.error ?? "error", 36)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      </main>
    </ErrorBoundary>
  );
}

function Metric(props: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "danger" | "muted";
}): React.ReactElement {
  return (
    <div className={`ops-metric ops-metric--${props.tone ?? "muted"}`}>
      <div className="ops-metric-label">{props.label}</div>
      <div className="ops-metric-value">{props.value}</div>
    </div>
  );
}
