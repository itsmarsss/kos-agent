import { useCallback, useEffect, useMemo, useState } from "react";
import { summarizeAction } from "@kos/shared";

import {
  api,
  type AuditRecord,
  type BuildRecord,
  type CronJob,
  type FactRow,
  type PagePayload,
  type PageSummary,
  type PendingAction,
  type Project,
  type RunRecord,
  type Status,
  type Conversation,
} from "./api.js";
import { Inspector, type InspectTarget } from "./Inspector.js";
import { ListPage } from "./ListPage.js";
import { AnimatePresence, m } from "motion/react";

import { hrefFor, NAV, parseRoute, type Route } from "./routes.js";
import { Modal } from "./Modal.js";
import { CronEditor } from "./CronEditor.js";
import { ease, spring } from "./motion.js";
import { HomePage } from "./HomePage.js";
import { ChatsPage } from "./ChatsPage.js";
import { FilesPage } from "./FilesPage.js";
import { AgentsPage } from "./AgentsPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { ProjectsPage } from "./ProjectsPage.js";
import { KnowledgePage } from "./KnowledgePage.js";
import { CommandPalette, type PaletteContext } from "./CommandPalette.js";
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
  const [busy, setBusy] = useState<string | null>(null);
  /** Pending actions being decided right now. */
  const [deciding, setDeciding] = useState<ReadonlySet<number>>(new Set());
  const [toast, setToast] = useState<Toast>(null);
  const [activePage, setActivePage] = useState<PagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [runsFailedOnly, setRunsFailedOnly] = useState(false);
  const [cronFilter, setCronFilter] = useState<"all" | "on" | "off">("all");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Where sites are served, so the palette can open one directly.
  const [sitesBase, setSitesBase] = useState<string | null>(null);
  const [agents, setAgents] = useState<BuildRecord[]>([]);
  const [editingCron, setEditingCron] = useState<{ job?: CronJob } | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const flash = (kind: "ok" | "err", text: string): void => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  };

  /**
   * One poll feeds the whole dashboard. Settled rather than all: under
   * Promise.all a single failing endpoint rejected the batch and froze every
   * panel, so one slow query could leave a decided approval on screen for as
   * long as it kept failing. Each result is applied on its own.
   */
  const refresh = useCallback(async () => {
    const apply = <T,>(r: PromiseSettledResult<T>, set: (v: T) => void): void => {
      if (r.status === "fulfilled") set(r.value);
    };
    const [s, a, p, c, f, pg, act, mem, r, convos, ag] = await Promise.allSettled([
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
      api.agents(),
    ]);
    apply(s, setStatus);
    apply(a, setApprovals);
    apply(ag, (v) => setAgents(v.builds));
    apply(p, setProjects);
    apply(c, setCrons);
    apply(f, setFailed);
    apply(pg, setPages);
    apply(act, (v) => setActivity(v.tools));
    apply(mem, (v) => {
      setFacts(v.facts ?? []);
      setFactTags(v.tags ?? []);
    });
    apply(r, setRuns);
    apply(convos, setConversations);
    // The sheet's transcript is the orchestrator's own thread, not whichever
    // chat happens to be newest.
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    // A hidden tab has its timers throttled to about once a minute, so coming
    // back to one shows a minute-old dashboard until the next tick.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Read once: the port sites are served on is a property of how the host was
  // started, not something that changes while the page is open.
  useEffect(() => {
    void api
      .sites()
      .then((r) => setSitesBase(r.base))
      .catch(() => undefined);
  }, []);

  // One shortcut, and it opens the thing that reaches everything. It used to
  // open a chat with KOS, which Chats already does, so the most reachable key
  // in the app was spent on a second way to do one thing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
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
    // Tracked per id rather than as one busy flag, so a second approval
    // pending elsewhere is not disabled by this one, and every copy of the
    // buttons for this action agrees about what is happening.
    setDeciding((current) => new Set(current).add(id));
    setBusy(approved ? `approving #${id}` : `denying #${id}`);
    try {
      const res = await (approved ? api.approve(id) : api.deny(id));
      // The agent's continuation shows in the conversation it belongs to,
      // which Chats is already watching; there is no panel to echo it into.
      flash("ok", res.reply ? res.reply.slice(0, 120) : approved ? `Approved #${id}` : `Denied #${id}`);
      await refresh();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setDeciding((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
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

  // Everything the palette can do, in one place, so an action it offers is the
  // same code path as the button that used to be the only way to reach it.
  const paletteContext: PaletteContext = {
    go,
    openChat: (id) => {
      const target =
        id === "orchestrator"
          ? conversations.find((c) => c.kind === "orchestrator")?.id
          : id;
      if (target) go({ name: "chats", id: target });
    },
    openSettings: () => go({ name: "settings" }),
    newChat: () => {
      void api
        .newConversation()
        .then((c) => {
          void refresh();
          go({ name: "chats", id: c.id });
        })
        .catch((err: unknown) =>
          flash("err", err instanceof Error ? err.message : String(err)),
        );
    },
    openWorkspace: () => {
      void api
        .openWorkspace()
        .then((r) => flash("ok", `Opened ${r.opened}`))
        .catch((err: unknown) =>
          flash("err", err instanceof Error ? err.message : String(err)),
        );
    },
    snapshot: () => void doSnapshot(),
    refresh: () => void refresh(),
    openAgent: (agentId) => {
      // The route carries it, so the log opens straight from search rather
      // than landing on the list and making you find it again.
      go({ name: "agents", id: agentId });
    },
    sitesBase,
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
      {/* The chat route owns the whole window: the shell's scroll padding is
          for pages that scroll, and with it the document ran past the viewport
          so the page moved behind the chat, top bar and all. */}
      <main className={`ops ${route.name === "chats" ? "ops--full" : ""}`}>
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
            {/* Which model is answering. The routing table is picked from
                whichever API keys are present, so a workspace with one
                provider gets a different agent from the default; without this
                the only way to find out was to read the router. */}
            {status?.routes?.["reasoning"] && (
              <span
                className="health health--model"
                title={`${status.routes["reasoning"].provider} · reasoning turns`}
              >
                {status.routes["reasoning"].model}
              </span>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setPaletteOpen(true)}
            >
              Search <kbd>⌘K</kbd>
            </button>
            {/* A native details stays open when something inside it is
                clicked, so the menu sat over whatever it had just opened. */}
            <details
              className="menu"
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest("button, a")) {
                  e.currentTarget.removeAttribute("open");
                }
              }}
            >
              <summary className="btn btn--ghost" aria-label="More">⋯</summary>
              <div className="menu-body">
                <button type="button" onClick={() => void refresh()}>Refresh</button>
                <button type="button" onClick={() => void doSnapshot()}>Snapshot now</button>
                <button type="button" onClick={() => go({ name: "settings" })}>
                  Settings
                </button>
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

        <Modal
          open={editingCron !== null}
          title={editingCron?.job ? `Edit “${editingCron.job.name}”` : "New schedule"}
          onClose={() => setEditingCron(null)}
        >
          {editingCron && (
            <CronEditor
              {...(editingCron.job ? { job: editingCron.job } : {})}
              onDone={() => {
                setEditingCron(null);
                void refresh();
              }}
              onCancel={() => setEditingCron(null)}
            />
          )}
        </Modal>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          ctx={paletteContext}
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
        approvals={approvals}
        deciding={deciding}
        agents={agents}
        onOpenAgent={(id) => go({ name: "agents", id })}
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

  if (route.name === "agents") {
    return shell(
      <AgentsPage
        deciding={deciding}
        onDecide={(id, approved) => void decide(id, approved)}
        {...(route.id !== undefined ? { openId: route.id } : {})}
      />,
    );
  }

  if (route.name === "settings") {
    return shell(<SettingsPage />);
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
        subtitle="Jobs KOS runs on its own. Click a row to edit it."
        rows={rows}
        rowKey={(c) => c.id}
        empty="No crons match"
        onRowClick={(c) => setEditingCron({ job: c })}
        filters={
          <div className="list-filter-group">
            {/* Writing one by hand: everything here could be asked for in a
                sentence, but a schedule runs while nobody is watching, so it
                is worth being able to read exactly what will happen. */}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setEditingCron({})}
            >
              New schedule
            </button>
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

  return shell(
    <HomePage
      onOpenChat={(id) => go({ name: "chats", id })}
      onGo={(to) => go({ name: to } as Route)}
      deciding={deciding}
      onDecide={(id, approved) => void decide(id, approved)}
    />,
  );
}



