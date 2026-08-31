import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type ChatEvent,
  type Conversation,
} from "./api.js";
import { Inspector, type InspectTarget } from "./Inspector.js";
import { ListPage } from "./ListPage.js";
import { AnimatePresence, m } from "motion/react";

import { hrefFor, NAV, parseRoute, type Route } from "./routes.js";
import { ease, listItem, spring } from "./motion.js";
import { Home } from "./Home.js";
import { ChatsPage } from "./ChatsPage.js";
import { FilesPage } from "./FilesPage.js";
import { ProjectsPage } from "./ProjectsPage.js";
import { KnowledgePage } from "./KnowledgePage.js";
import { ChatPanel } from "./ChatPanel.js";
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
  const [factTags, setFactTags] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [thread, setThread] = useState<ChatEvent[]>([]);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [activePage, setActivePage] = useState<PagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [runsFailedOnly, setRunsFailedOnly] = useState(false);
  const [cronFilter, setCronFilter] = useState<"all" | "on" | "off">("all");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeChat, setActiveChat] = useState<string | null>(null);

  const flash = (kind: "ok" | "err", text: string): void => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  };

  const refresh = useCallback(async () => {
    const [s, a, p, c, f, pg, act, mem, r, convos] = await Promise.all([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.failed(100),
      api.pages(),
      api.activity(200),
      api.memory(300),
      api.runs(200, false),
      api.conversations(),
    ]);
    setStatus(s);
    setApprovals(a);
    setProjects(p);
    setCrons(c);
    setFailed(f);
    setPages(pg);
    setActivity(act.tools);
    setFacts(mem.facts ?? []);
    setFactTags(mem.tags ?? []);
    setRuns(r);
    setConversations(convos);
    // The sheet's transcript is the orchestrator's own thread, not whichever
    // chat happens to be newest.
    setActiveChat(s.orchestratorId ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Chat is summoned, not resident. Cmd-K is the one shortcut worth having.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setChatOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      if (res.reply) {
        setThread((t) => [
          ...t,
          { kind: "message", role: "kos", text: res.reply! },
        ]);
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
    setThread((t) => [...t, { kind: "message", role: "you", text }]);
    setPrompt("");
    try {
      const res = await api.orchestrator(text);
      // Reload: the turn's tool calls belong in the transcript, and appending
      // only the reply would hide the work that produced it.
      const { events } = await api.conversation(res.conversationId);
      setThread(events);
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setThread((t) => [...t, { kind: "message", role: "kos", text: `Error: ${msg}` }]);
      flash("err", msg);
    } finally {
      setSending(false);
    }
  };

  /**
   * One place loads a transcript: whenever the active conversation changes to
   * one we have not loaded. Doing it only inside a click handler missed the
   * first conversation, which is selected automatically after the initial poll.
   */
  const loadedChat = useRef<string | null>(null);
  useEffect(() => {
    if (!activeChat || loadedChat.current === activeChat) return;
    loadedChat.current = activeChat;
    let cancelled = false;
    void api
      .conversation(activeChat)
      .then(({ events }) => {
        if (!cancelled) setThread(events);
      })
      .catch(() => {
        if (!cancelled) setThread([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChat]);




  /** Pending-action ids, so a queued tool call can offer a decision in place. */
  const pendingIds = useMemo(
    () => new Set(approvals.map((a) => String(a.id))),
    [approvals],
  );

  const decideByPendingId = (pendingId: string, approved: boolean): void => {
    const id = Number(pendingId);
    if (Number.isInteger(id)) void decide(id, approved);
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
        <AnimatePresence>
          {toast && (
            <m.div
              key={toast.text}
              className={`ops-toast ops-toast--${toast.kind}`}
              role="status"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={spring}
            >
              {toast.text}
            </m.div>
          )}
        </AnimatePresence>
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

        <header className="topbar">
          <div className="topbar-left">
            <a className="brand" href="#/">
              K<span>-OS</span>
            </a>
            <nav className="tabs" aria-label="Primary">
              {NAV.map((item) => {
                const active =
                  route.name === item.route.name ||
                  (item.route.name === "home" && route.name === "page");
                return (
                  <a
                    key={item.label}
                    href={hrefFor(item.route)}
                    className={`tab ${active ? "is-active" : ""}`}
                  >
                    {item.label}
                  </a>
                );
              })}
            </nav>
          </div>
          <div className="topbar-right">
            {busy && <span className="hint">{busy}…</span>}
            <span
              className={`health ${status?.halted ? "health--halted" : "health--ok"}`}
              title={status?.workspace ?? ""}
            >
              <span className="health-dot" />
              {status?.halted ? "Halted" : "Running"}
            </span>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setChatOpen(true)}
            >
              Ask KOS <kbd>⌘K</kbd>
            </button>
            <details className="menu">
              <summary className="btn btn--ghost" aria-label="More">⋯</summary>
              <div className="menu-body">
                <button type="button" onClick={() => void refresh()}>Refresh</button>
                <button type="button" onClick={() => void doSnapshot()}>Snapshot now</button>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .openWorkspace()
                      .then((r) => flash("ok", `Opened ${r.opened}`))
                      .catch((err: unknown) =>
                        flash("err", err instanceof Error ? err.message : String(err)),
                      );
                  }}
                >
                  Open workspace folder
                </button>
                <button type="button" onClick={() => void copyWorkspace()}>Copy workspace path</button>
                <button type="button" className="is-danger" onClick={() => void toggleKill()}>
                  {status?.halted ? "Resume KOS" : "Halt KOS"}
                </button>
              </div>
            </details>
          </div>
        </header>

        <AnimatePresence initial={false}>
          {approvals.length > 0 && route.name !== "home" && (
            <m.a
              className="attention"
              href="#/"
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: "auto", marginBottom: 16 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={ease}
            >
              <strong>{approvals.length}</strong>
              {approvals.length === 1 ? " action needs you" : " actions need you"}
              <span className="attention-go">Review →</span>
            </m.a>
          )}
        </AnimatePresence>

        {body}

        <ChatPanel
          open={chatOpen}
          thread={thread}
          prompt={prompt}
          sending={sending}
          onPrompt={setPrompt}
          onSend={() => void send()}
          onClose={() => setChatOpen(false)}
          onClear={() => void doClear()}
          pendingApprovals={pendingIds}
          onDecide={decideByPendingId}
        />
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
          ← Home
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
  if (route.name === "chats") {
    return shell(
      <ChatsPage
        conversations={conversations}
        {...(route.id ? { activeId: route.id } : {})}
        pendingApprovals={pendingIds}
        onOpen={(id) => go({ name: "chats", id })}
        onChanged={() => void refresh()}
        onDecide={decideByPendingId}
      />,
    );
  }

  if (route.name === "files") {
    return shell(
      <FilesPage
        {...(route.path ? { path: route.path } : {})}
        onOpen={(p) => go({ name: "files", path: p })}
      />,
    );
  }

  if (route.name === "projects") {
    return shell(
      <ProjectsPage
        projects={projects}
        pagesByProject={pagesByProject}
        onInspect={(project, pages) =>
          setInspect({ kind: "project", data: project, pages })
        }
      />,
    );
  }

  if (route.name === "tools") {
    return shell(
      <ListPage
        title="Activity"
        subtitle="Every tool KOS has run. Click a row for the arguments and result."
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
        title="Schedule"
        subtitle="Jobs KOS runs on its own. Click a row to turn one off or delete it."
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
      <KnowledgePage
        facts={facts}
        tags={factTags}
        onChanged={() => void refresh()}
      />,
    );
  }

  if (route.name === "runs") {
    const source = runsFailedOnly ? failed : runs;
    return shell(
      <ListPage
        title="Runs"
        subtitle="Every chat turn and scheduled job, with failures surfaced."
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

  const homeFailed = failed.slice(0, 5);

  return shell(
    <>
      <AnimatePresence initial={false}>
      {approvals.length > 0 && (
        <m.section
          className="needs-you"
          aria-label="Pending approvals"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0, overflow: "hidden" }}
          transition={ease}
        >
          <h2>
            {approvals.length === 1
              ? "1 action needs you"
              : `${approvals.length} actions need you`}
          </h2>
          <AnimatePresence initial={false}>
          {approvals.map((a) => (
            <m.div
              key={a.id}
              className="approval"
              layout
              variants={listItem}
              initial="hidden"
              animate="show"
              exit="exit"
              transition={ease}
            >
              <div className="approval-main">
                <div className="approval-title">
                  {summarizeAction(a.tool, a.args)}
                </div>
                <div className="approval-meta">
                  <code>{a.tool}</code>
                  {a.reason ? <span> · {a.reason}</span> : null}
                </div>
              </div>
              <div className="approval-actions">
                <button
                  type="button"
                  className="btn btn--ok"
                  onClick={() => void decide(a.id, true)}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn--danger-ghost"
                  onClick={() => void decide(a.id, false)}
                >
                  Deny
                </button>
              </div>
            </m.div>
          ))}
          </AnimatePresence>
        </m.section>
      )}
      </AnimatePresence>

      <Home
        projects={projects}
        pagesByProject={pagesByProject}
        onInspect={(project, pages) =>
          setInspect({ kind: "project", data: project, pages })
        }
      />

      <section className="lately" aria-label="Recent activity">
        <div className="lately-head">
          <h2>Lately</h2>
          <a className="link" href="#/runs">
            All activity →
          </a>
        </div>
        <ul className="feed">
          {homeFailed.slice(0, 2).map((r) => (
            <li key={`f${r.id}`} className="feed-item feed-item--bad">
              <button type="button" onClick={() => setInspect({ kind: "run", data: r })}>
                <span className="feed-what">{r.kind} run failed</span>
                <span className="feed-detail">{preview(r.error ?? "", 60)}</span>
                <span className="feed-when">{timeAgo(r.startedAt)}</span>
              </button>
            </li>
          ))}
          {activity.slice(0, 6).map((t) => (
            <li key={t.id} className="feed-item">
              <button type="button" onClick={() => setInspect({ kind: "tool", data: t })}>
                <span className="feed-what">{summarizeAction(t.tool, t.args)}</span>
                <span className="feed-detail">
                  <code>{t.tool}</code>
                </span>
                <span className="feed-when">{timeAgo(t.createdAt)}</span>
              </button>
            </li>
          ))}
          {activity.length === 0 && homeFailed.length === 0 && (
            <li className="feed-empty">Nothing yet.</li>
          )}
        </ul>
      </section>
    </>,
  );
}


