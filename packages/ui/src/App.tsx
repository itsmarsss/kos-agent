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
import { ListPage } from "./ListPage.js";
import { hrefFor, NAV, parseRoute, type Route } from "./routes.js";
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

export function App(): React.ReactElement {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  const [status, setStatus] = useState<Status | null>(null);
  const [approvals, setApprovals] = useState<PendingAction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
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
  const [activePage, setActivePage] = useState<PagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [runsFailedOnly, setRunsFailedOnly] = useState(false);
  const [cronFilter, setCronFilter] = useState<"all" | "on" | "off">("all");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);

  const flash = (kind: "ok" | "err", text: string): void => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  };

  const refresh = useCallback(async () => {
    const [s, a, p, c, f, pg, act, mem, r] = await Promise.all([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.failed(100),
      api.pages(),
      api.activity(200),
      api.memory(300),
      api.runs(200, false),
    ]);
    setStatus(s);
    setApprovals(a);
    setProjects(p);
    setCrons(c);
    setFailed(f);
    setPages(pg);
    setActivity(act.tools);
    setFacts(mem.facts ?? []);
    setRuns(r);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const sync = (): void => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
      if (next.name === "page") {
        setPageError(null);
        setActivePage(null);
        void api
          .page(next.id)
          .then((payload) => setActivePage(payload))
          .catch((err: unknown) => {
            setPageError(err instanceof Error ? err.message : String(err));
          });
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

  const go = (r: Route): void => {
    window.location.hash = hrefFor(r);
  };

  const openPage = (id: string): void => {
    setInspect(null);
    go({ name: "page", id });
  };

  const decide = async (id: number, approved: boolean): Promise<void> => {
    setBusy(approved ? `approving #${id}` : `denying #${id}`);
    try {
      const res = await (approved ? api.approve(id) : api.deny(id));
      if (res.reply) setThread((t) => [...t, { role: "kos", text: res.reply! }]);
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
      flash("ok", res.sha ? `Snapshot ${res.sha.slice(0, 10)}` : "Nothing to snapshot");
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

  const inspectKey =
    inspect == null
      ? "none"
      : inspect.kind === "tool"
        ? `tool-${inspect.data.id}`
        : inspect.kind === "cron"
          ? `cron-${inspect.data.id}`
          : inspect.kind === "run"
            ? `run-${inspect.data.id}`
            : inspect.kind === "fact"
              ? `fact-${inspect.data.key}`
              : `project-${inspect.data.slug}`;

  const shell = (body: React.ReactNode): React.ReactElement => (
    <ErrorBoundary label="dashboard">
      <main className="ops">
        {toast && (
          <div className={`ops-toast ops-toast--${toast.kind}`} role="status">
            {toast.text}
          </div>
        )}
        <Inspector
          key={inspectKey}
          target={inspect}
          onClose={() => setInspect(null)}
          onOpenPage={openPage}
          onSaved={() => void refresh()}
          onSetProjectStatus={async (slug, st) => {
            await api.setProjectStatus(slug, st);
            flash("ok", `Project ${slug} → ${st}`);
            await refresh();
          }}
          onToggleCron={async (id, enabled) => {
            await api.setCronEnabled(id, enabled);
            flash("ok", enabled ? `Cron #${id} enabled` : `Cron #${id} disabled`);
            await refresh();
          }}
          onDeleteCron={async (id) => {
            await api.deleteCron(id);
            flash("ok", `Deleted cron #${id}`);
            await refresh();
          }}
          onSaveFact={async (key, value, kind) => {
            await api.saveMemory(key, value, kind);
            flash("ok", `Saved ${key}`);
            await refresh();
          }}
          onDeleteFact={async (key) => {
            await api.deleteMemory(key);
            flash("ok", `Deleted ${key}`);
            await refresh();
          }}
        />

        <header className="ops-top">
          <div className="ops-top-left">
            <div className="ops-logo">
              K<span>-OS</span>
            </div>
            <nav className="ops-nav-main" aria-label="Primary">
              {NAV.map((item) => {
                const active =
                  route.name === item.route.name ||
                  (item.route.name === "home" && route.name === "page");
                return (
                  <a
                    key={item.label}
                    href={hrefFor(item.route)}
                    className={`ops-nav-link ${active ? "is-active" : ""}`}
                  >
                    {item.label}
                  </a>
                );
              })}
            </nav>
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
            tone={status && !status.halted ? "ok" : status?.halted ? "danger" : "muted"}
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
          <Metric label="Crons" value={String(crons.length)} />
          <Metric label="Projects" value={String(projects.length)} />
          <button type="button" className="ops-path ops-path--metric" onClick={() => void copyWorkspace()}>
            {status?.workspace ?? "workspace"}
          </button>
        </div>

        {body}
      </main>
    </ErrorBoundary>
  );

  // —— agent page ——
  if (route.name === "page") {
    return shell(
      <>
        <a
          className="ops-back"
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            go({ name: "home" });
          }}
        >
          ← Ops
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
      </>,
    );
  }

  // —— list pages ——
  if (route.name === "projects") {
    return shell(
      <ListPage
        title="Projects"
        subtitle="All workspace projects and linked pages"
        rows={projects}
        rowKey={(p) => p.slug}
        empty="No projects match"
        onRowClick={(p) =>
          setInspect({
            kind: "project",
            data: p,
            pages: pagesByProject.get(p.slug) ?? [],
          })
        }
        columns={[
          {
            key: "name",
            header: "Name",
            searchText: (p) => `${p.name} ${p.slug}`,
            render: (p) => (
              <div>
                <div className="ops-nav-title">{p.name}</div>
                <div className="ops-mono ops-muted">{p.slug}</div>
              </div>
            ),
          },
          {
            key: "type",
            header: "Type",
            searchText: (p) => p.type,
            render: (p) => p.type,
          },
          {
            key: "module",
            header: "Module",
            searchText: (p) => p.module ?? "",
            render: (p) => (
              <span className="ops-mono">{p.module ?? "—"}</span>
            ),
          },
          {
            key: "status",
            header: "Status",
            searchText: (p) => p.status,
            render: (p) => (
              <span className={`ops-status ops-status--${p.status}`}>
                {p.status}
              </span>
            ),
          },
          {
            key: "pages",
            header: "Pages",
            render: (p) => {
              const linked = pagesByProject.get(p.slug) ?? [];
              if (linked.length === 0) return <span className="ops-muted">—</span>;
              return (
                <span className="ops-page-chips">
                  {linked.map((pg) => (
                    <span
                      key={pg.id}
                      className="ops-chip"
                      onClick={(e) => {
                        e.stopPropagation();
                        openPage(pg.id);
                      }}
                      role="link"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          openPage(pg.id);
                        }
                      }}
                    >
                      {pg.title}
                    </span>
                  ))}
                </span>
              );
            },
          },
          {
            key: "touched",
            header: "Touched",
            render: (p) => (
              <span className="ops-muted">{timeAgo(p.lastTouchedAt)}</span>
            ),
          },
        ]}
      />,
    );
  }

  if (route.name === "tools") {
    return shell(
      <ListPage
        title="Tool calls"
        subtitle="Audit log · click a row for args and result"
        rows={activity}
        rowKey={(t) => t.id}
        empty="No tool calls yet"
        onRowClick={(t) => setInspect({ kind: "tool", data: t })}
        columns={[
          {
            key: "tool",
            header: "Tool",
            width: "18%",
            searchText: (t) => t.tool,
            render: (t) => <span className="ops-mono">{t.tool}</span>,
          },
          {
            key: "preview",
            header: "Preview",
            searchText: (t) => summarizeAction(t.tool, t.args),
            render: (t) => preview(summarizeAction(t.tool, t.args), 64),
          },
          {
            key: "status",
            header: "Status",
            width: "10%",
            searchText: (t) => (t.isError ? "error" : "ok"),
            render: (t) =>
              t.isError ? (
                <span className="ops-tag ops-tag--danger">error</span>
              ) : (
                <span className="ops-tag ops-tag--ok">ok</span>
              ),
          },
          {
            key: "when",
            header: "When",
            width: "10%",
            render: (t) => (
              <span className="ops-muted">{timeAgo(t.createdAt)}</span>
            ),
          },
        ]}
      />,
    );
  }

  if (route.name === "crons") {
    const rows = crons.filter((c) => {
      if (cronFilter === "on") return c.enabled;
      if (cronFilter === "off") return !c.enabled;
      return true;
    });
    return shell(
      <ListPage
        title="Crons"
        subtitle="Scheduled jobs · enable/disable/delete in the drawer"
        rows={rows}
        rowKey={(c) => c.id}
        empty="No crons match"
        onRowClick={(c) => setInspect({ kind: "cron", data: c })}
        filters={
          <div className="list-filter-group">
            {(["all", "on", "off"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`ops-btn ${cronFilter === f ? "ops-btn--primary" : ""}`}
                onClick={() => setCronFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        }
        columns={[
          {
            key: "name",
            header: "Name",
            searchText: (c) => c.name,
            render: (c) => c.name,
          },
          {
            key: "schedule",
            header: "Schedule",
            searchText: (c) => c.schedule,
            render: (c) => <span className="ops-mono">{c.schedule}</span>,
          },
          {
            key: "type",
            header: "Type",
            searchText: (c) => c.type,
            render: (c) => c.type,
          },
          {
            key: "enabled",
            header: "Enabled",
            searchText: (c) => (c.enabled ? "on" : "off"),
            render: (c) =>
              c.enabled ? (
                <span className="ops-tag ops-tag--ok">on</span>
              ) : (
                <span className="ops-tag ops-tag--muted">off</span>
              ),
          },
          {
            key: "project",
            header: "Project",
            searchText: (c) => c.projectSlug ?? "",
            render: (c) => (
              <span className="ops-mono ops-muted">{c.projectSlug ?? "—"}</span>
            ),
          },
        ]}
      />,
    );
  }

  if (route.name === "memory") {
    return shell(
      <ListPage
        title="Memory"
        subtitle="Durable facts · edit or delete in the drawer"
        rows={facts}
        rowKey={(f) => f.key}
        empty="No facts yet"
        onRowClick={(f) => setInspect({ kind: "fact", data: f })}
        columns={[
          {
            key: "key",
            header: "Key",
            width: "22%",
            searchText: (f) => f.key,
            render: (f) => <span className="ops-mono">{f.key}</span>,
          },
          {
            key: "value",
            header: "Value",
            searchText: (f) => f.value,
            render: (f) => preview(f.value, 80),
          },
          {
            key: "kind",
            header: "Kind",
            width: "12%",
            searchText: (f) => f.kind,
            render: (f) => f.kind,
          },
          {
            key: "updated",
            header: "Updated",
            width: "12%",
            render: (f) => (
              <span className="ops-muted">
                {f.updatedAt ? timeAgo(f.updatedAt) : "—"}
              </span>
            ),
          },
        ]}
      />,
    );
  }

  if (route.name === "runs") {
    const source = runsFailedOnly ? failed : runs;
    return shell(
      <ListPage
        title="Runs"
        subtitle="Job / chat run log"
        rows={source}
        rowKey={(r) => r.id}
        empty="No runs"
        onRowClick={(r) => setInspect({ kind: "run", data: r })}
        filters={
          <label className="list-check">
            <input
              type="checkbox"
              checked={runsFailedOnly}
              onChange={(e) => setRunsFailedOnly(e.target.checked)}
            />
            Failures only
          </label>
        }
        columns={[
          {
            key: "id",
            header: "ID",
            width: "8%",
            render: (r) => <span className="ops-mono">#{r.id}</span>,
          },
          {
            key: "kind",
            header: "Kind",
            searchText: (r) => r.kind,
            render: (r) => r.kind,
          },
          {
            key: "status",
            header: "Status",
            searchText: (r) => r.status,
            render: (r) => (
              <span
                className={`ops-tag ${r.status === "error" ? "ops-tag--danger" : r.status === "ok" ? "ops-tag--ok" : "ops-tag--muted"}`}
              >
                {r.status}
              </span>
            ),
          },
          {
            key: "error",
            header: "Error",
            searchText: (r) => r.error ?? "",
            render: (r) => (
              <span className="ops-muted">{preview(r.error ?? "—", 56)}</span>
            ),
          },
          {
            key: "when",
            header: "When",
            render: (r) => (
              <span className="ops-muted">{timeAgo(r.startedAt)}</span>
            ),
          },
        ]}
      />,
    );
  }

  // —— home ops ——
  const homeProjects = projects.slice(0, 6);
  const homeTools = activity.slice(0, 8);
  const homeCrons = crons.slice(0, 6);
  const homeFacts = facts.slice(0, 6);
  const homeFailed = failed.slice(0, 5);

  return shell(
    <>
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
                Message KOS here. Use the nav for full lists (Projects, Tools, …).
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
              placeholder="Ask KOS…"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="ops-composer-bar">
              <span className="ops-muted">⌘/Ctrl+Enter</span>
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
            <a className="ops-link" href="#/tools">
              View all →
            </a>
          </div>
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Preview</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {homeTools.length === 0 && (
                  <tr>
                    <td colSpan={3} className="ops-muted">
                      No tool calls yet
                    </td>
                  </tr>
                )}
                {homeTools.map((t) => (
                  <tr
                    key={t.id}
                    className="ops-row-click"
                    onClick={() => setInspect({ kind: "tool", data: t })}
                  >
                    <td className="ops-mono">{t.tool}</td>
                    <td className="ops-muted">
                      {preview(summarizeAction(t.tool, t.args), 40)}
                    </td>
                    <td className="ops-muted">{timeAgo(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="ops-side">
          <PreviewPanel
            title="Projects"
            href="#/projects"
            empty={homeProjects.length === 0}
          >
            <ul className="ops-dense">
              {homeProjects.map((p) => {
                const pages = pagesByProject.get(p.slug) ?? [];
                return (
                  <li key={p.slug}>
                    <button
                      type="button"
                      className="ops-dense-btn"
                      onClick={() =>
                        setInspect({ kind: "project", data: p, pages })
                      }
                    >
                      <span>{p.name}</span>
                      <span className={`ops-status ops-status--${p.status}`}>
                        {p.status}
                      </span>
                    </button>
                    {pages.length > 0 && (
                      <div className="ops-dense-pages">
                        {pages.map((pg) => (
                          <a
                            key={pg.id}
                            className="ops-page-chip"
                            href={hrefFor({ name: "page", id: pg.id })}
                          >
                            {pg.title}
                          </a>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </PreviewPanel>

          <PreviewPanel title="Crons" href="#/crons" empty={homeCrons.length === 0}>
            <ul className="ops-dense">
              {homeCrons.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="ops-dense-btn"
                    onClick={() => setInspect({ kind: "cron", data: c })}
                  >
                    <span>{c.name}</span>
                    <span className="ops-mono ops-muted">{c.schedule}</span>
                  </button>
                </li>
              ))}
            </ul>
          </PreviewPanel>

          <PreviewPanel
            title="Memory"
            href="#/memory"
            empty={homeFacts.length === 0}
          >
            <ul className="ops-dense">
              {homeFacts.map((f) => (
                <li key={f.key}>
                  <button
                    type="button"
                    className="ops-dense-btn"
                    onClick={() => setInspect({ kind: "fact", data: f })}
                  >
                    <span className="ops-mono">{f.key}</span>
                    <span className="ops-muted">{preview(f.value, 28)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </PreviewPanel>

          {homeFailed.length > 0 && (
            <PreviewPanel
              title="Failed runs"
              href="#/runs"
              empty={false}
              danger
            >
              <ul className="ops-dense">
                {homeFailed.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="ops-dense-btn"
                      onClick={() => setInspect({ kind: "run", data: r })}
                    >
                      <span>{r.kind}</span>
                      <span className="ops-muted">
                        {preview(r.error ?? "", 28)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </PreviewPanel>
          )}
        </aside>
      </div>
    </>,
  );
}

function PreviewPanel(props: {
  title: string;
  href: string;
  empty: boolean;
  danger?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      className={`ops-panel ${props.danger ? "ops-panel--danger" : ""}`}
    >
      <div className="ops-section-head">
        <h2>{props.title}</h2>
        <a className="ops-link" href={props.href}>
          View all →
        </a>
      </div>
      {props.empty ? <p className="ops-muted">None.</p> : props.children}
    </section>
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
