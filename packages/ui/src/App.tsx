import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type FailingJob,
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
  type InboxData,
} from "./api.js";
import { Inspector, type InspectTarget } from "./Inspector.js";
import { ListPage } from "./ListPage.js";
import { AnimatePresence, m } from "motion/react";

import { hrefFor, parseRoute, type Route } from "./routes.js";
import { Drawer } from "./Drawer.js";
import { CronEditor } from "./CronEditor.js";
import { ease, spring } from "./motion.js";
import { HistoryPage, type HistoryRow } from "./HistoryPage.js";
import { HomePage } from "./HomePage.js";
import { ChatsPage } from "./ChatsPage.js";
import { QuickAsk } from "./QuickAsk.js";
import { FilesPage } from "./FilesPage.js";
import { AgentsPage } from "./AgentsPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { ProjectsPage } from "./ProjectsPage.js";
import { placeOf } from "./chattree.js";
import { MemoryPage } from "./MemoryPage.js";
import { InboxPage } from "./InboxPage.js";
import { RunsTabs } from "./RunsTabs.js";
import { Sidebar } from "./Sidebar.js";
import { CommandPalette, type PaletteContext } from "./CommandPalette.js";
import { ErrorBoundary } from "./widgets/ErrorBoundary.js";
import { PageRenderer } from "./widgets/PageRenderer.js";

type Toast = { kind: "ok" | "err"; text: string } | null;

export function App(): React.ReactElement {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  const [status, setStatus] = useState<Status | null>(null);
  const [approvals, setApprovals] = useState<PendingAction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [crons, setCrons] = useState<CronJob[]>([]);
  /** The job being run by hand, so its own button can say so. */
  const [firing, setFiring] = useState<number | null>(null);
  /** A message the harness sent, until the transcript has it. */
  const [seed, setSeed] = useState<{ id: string; text: string } | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
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
  const [cronFilter, setCronFilter] = useState<"all" | "on" | "off">("all");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The quick-question window: the sidebar entry or Cmd/Ctrl+Shift+K. */
  const [askOpen, setAskOpen] = useState(false);
  /** A question typed as `/btw` in a chat, handed to the window to ask. */
  const [askSeed, setAskSeed] = useState<{ text: string; n: number } | null>(null);
  const askAside = (text: string): void => {
    setAskSeed({ text, n: Date.now() });
    setAskOpen(true);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setAskOpen((v) => !v);
      } else if (e.key === "Escape") {
        setAskOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** Everything waiting on the owner, for the Inbox and its badge. */
  const [inbox, setInbox] = useState<InboxData | null>(null);
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
    // One fewer request than this used to make: the failures-only view was a
    // separate fetch, and History filters the rows it already has.
    const [s, a, p, c, pg, act, mem, r, convos, ag, ib] = await Promise.allSettled([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.pages(),
      api.activity(200),
      api.memory(300),
      api.runs(200, false),
      api.conversations(),
      api.agents(),
      api.inbox(),
    ]);
    apply(s, setStatus);
    apply(ib, setInbox);
    apply(a, setApprovals);
    apply(ag, (v) => setAgents(v.builds));
    apply(p, setProjects);
    apply(c, setCrons);
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
    /*
     * Nothing is fetched for a tab nobody is looking at.
     *
     * One poll is about 420KB against a real workspace, most of it the audit
     * log, and it ran every five seconds whether or not the window was on
     * screen. A hidden tab still fires the timer, just throttled, so an open
     * background tab cost megabytes an hour to show nobody anything.
     */
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, 5000);
    // Coming back refreshes at once, so skipping the hidden ticks never
    // leaves a stale dashboard on screen.
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
      // Shift+K is the quick question's; without this both opened at once.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
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

  const decide = async (id: number, approved: boolean, remember = false): Promise<void> => {
    // Tracked per id rather than as one busy flag, so a second approval
    // pending elsewhere is not disabled by this one, and every copy of the
    // buttons for this action agrees about what is happening.
    setDeciding((current) => new Set(current).add(id));
    setBusy(approved ? `approving #${id}` : `denying #${id}`);
    try {
      const res = await (approved ? api.approve(id, remember) : api.deny(id));
      // The agent's continuation shows in the conversation it belongs to,
      // which Chats is already watching; there is no panel to echo it into.
      flash("ok", res.reply ? res.reply.slice(0, 120) : approved ? (remember ? `Approved #${id}, and remembered` : `Approved #${id}`) : `Denied #${id}`);
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

  /**
   * Run a scheduled job by hand, through the same path the schedule uses, and
   * say what came back. A job that fires and fails is a more useful answer
   * than one that quietly did nothing.
   */
  const runCronNow = async (id: number, name: string): Promise<void> => {
    setFiring(id);
    try {
      const result = await api.runCron(id);
      await refresh();
      if (result.ok) {
        flash("ok", `${name} ran`);
      } else {
        // "It fired" is not "it worked". A job whose every action errored
        // fires perfectly well, and calling that a success is how someone
        // checks a broken job and walks away satisfied.
        flash("err", `${name} failed: ${result.error ?? "unknown error"}`);
      }
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setFiring(null);
    }
  };

  /** Clear a failure the owner has handled, so the header stops shouting. */
  const dismissFailure = async (key: string): Promise<void> => {
    try {
      await api.dismissFailure(key);
      await refresh();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Hand a failure to KOS in its own chat, and go there. The agent that can
   * fix a broken schedule or a missing file is this one; a coding sub-agent
   * sandboxed to a folder cannot reach either.
   */
  const beginFix = async (detail: {
    label: string;
    error: string;
    what: string;
    ref?: string;
  }): Promise<void> => {
    try {
      const started = await api.fix({
        label: detail.label,
        error: detail.error,
        what: detail.what,
        ...(detail.ref ? { ref: detail.ref } : {}),
      });
      // Carried into the chat so the question is on screen the moment it
      // opens, rather than appearing when the turn finishes recording.
      setSeed({ id: started.conversationId, text: started.prompt });
      await refresh();
      go({ name: "chats", id: started.conversationId });
      flash("ok", "KOS is looking into it");
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    }
  };

  /** A failure as the health report describes it. */
  const fixFailure = (failure: FailingJob): void => {
    const cron = /^cron:(\d+)$/.exec(failure.key);
    void beginFix({
      label: failure.label,
      error: failure.error ?? "the job reported an error",
      what: cron ? "scheduled job" : "job",
      ...(cron ? { ref: `cron #${cron[1]}` } : {}),
    });
  };

  const startFix = async (row: HistoryRow): Promise<void> => {
    const detail =
      row.kind === "tool"
        ? {
            label: row.tool.tool,
            error: row.tool.result || "the tool reported an error",
            what: "tool call",
            ref: `tool call #${row.tool.id}`,
          }
        : {
            label:
              crons.find((c) => String(c.id) === row.run.ref)?.name ??
              `${row.run.kind} run`,
            error: row.run.error ?? "the run reported an error",
            what: row.run.kind === "cron" ? "scheduled job" : "run",
            ref: row.run.ref ? `${row.run.kind} #${row.run.ref}` : undefined,
          };
    await beginFix(detail);
  };

  /**
   * Open whatever a failure belongs to. The key names the kind and the id,
   * so a broken schedule opens its own editor rather than dropping the owner
   * on a list to find it again.
   */
  const openFailure = (key: string): void => {
    const cron = /^cron:(\d+)$/.exec(key);
    const job = cron ? crons.find((c) => c.id === Number(cron[1])) : undefined;
    if (job) {
      setEditingCron({ job });
      return;
    }
    go({ name: "history" });
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
      // Folders with their own git repo are not in it. A backup that quietly
      // leaves things out is worse than one you know the edges of.
      const omitted =
        res.excluded.length > 0
          ? ` · ${res.excluded.length} folder${
              res.excluded.length === 1 ? "" : "s"
            } with own repo not included`
          : "";
      flash(
        "ok",
        res.sha
          ? `Snapshot ${res.sha.slice(0, 10)}${omitted}`
          : `Nothing to snapshot${omitted}`,
      );
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

  const decideByPendingId = (pendingId: string, approved: boolean, remember = false): void => {
    const id = Number(pendingId);
    if (Number.isInteger(id)) void decide(id, approved, remember);
  };

  const inspectKey =
    inspect == null
      ? "none"
      : inspect.kind === "tool"
        ? `tool-${inspect.data.id}`
        : inspect.kind === "run"
          ? `run-${inspect.data.id}`
          : `project-${inspect.data.slug}`;

  /** A project's threads open inside the project; the rest open in Chats. */
  const openConversation = (id: string): void => {
    const known = conversations.find((c) => c.id === id);
    if (known) {
      go(placeOf(id, known));
      return;
    }
    // Just made (the + in a project, /agent, /fork), so not in the list this
    // render has: ask for the list rather than guess, or an agent opened in
    // Chats instead of in its project.
    void api
      .conversations()
      .then((list) => go(placeOf(id, list.find((c) => c.id === id))))
      .catch(() => go(placeOf(id)));
  };
  /** The thread the quick question is asked beside, if one is open. */
  const askContext =
    route.name === "chats"
      ? route.id
      : route.name === "project"
        ? (route.id ?? `project:${route.slug}`)
        : undefined;

  const shell = (body: React.ReactNode): React.ReactElement => (
    <ErrorBoundary label="dashboard">
      {/* The chat route owns the whole window: the shell's scroll padding is
          for pages that scroll, and with it the document ran past the viewport
          so the page moved behind the chat, top bar and all. */}
      <div className="app">
      <Sidebar
        route={route}
        status={status}
        inboxCount={inbox ? inbox.approvals.length + inbox.decisions.length + inbox.failures.length + inbox.suggestions.length : approvals.length}
        busy={busy}
        onSearch={() => setPaletteOpen(true)}
        onAsk={() => setAskOpen((v) => !v)}
        onRefresh={() => void refresh()}
        onSnapshot={() => void doSnapshot()}
        onOpenWorkspace={() => {
          void api
            .openWorkspace()
            .then((r) => flash("ok", `Opened ${r.opened}`))
            .catch((err: unknown) => flash("err", err instanceof Error ? err.message : String(err)));
        }}
        onCopyWorkspace={() => void copyWorkspace()}
        onToggleKill={() => void toggleKill()}
      />
      <main className={`ops ${route.name === "chats" || route.name === "project" ? "ops--full" : ""}`}>
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
        {/* Wrapped so it unmounts: the panel returned null when closed, which
            skips the exit animation entirely and makes a drawer vanish rather
            than close. */}
        <AnimatePresence>
          {inspect && (
          <Inspector
            key={inspectKey}
            target={inspect}
            onClose={() => setInspect(null)}
            onOpenPage={openPage}
            crons={crons}
            onFix={(detail) => void beginFix(detail)}
            onOpenProjectChat={(slug) => {
              setInspect(null);
              go({ name: "project", slug });
            }}
            onOpenFolder={(path) => {
              setInspect(null);
              go({ name: "files", path });
            }}
            onSaved={() => void refresh()}
            onSetProjectStatus={async (slug, st) => {
              await api.setProjectStatus(slug, st);
              flash("ok", `Project ${slug} → ${st}`);
              await refresh();
            }}
          />
          )}
        </AnimatePresence>



        {/* A page arriving. Keyed on the route so switching tabs is a change
            the eye can follow rather than a swap between two frames. Short
            and small: this is orientation, not decoration. */}
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={route.name}
            className="ops-page"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={ease}
          >
            {body}
          </m.div>
        </AnimatePresence>

        {/* A drawer: a schedule has a name, a cron line, a type and a body
            of actions, which is more than a dialog in the middle of the page
            should be asked to hold. */}
        <Drawer
          open={editingCron !== null}
          title={editingCron?.job ? editingCron.job.name : "New schedule"}
          {...(editingCron?.job
            ? { subtitle: `Cron #${editingCron.job.id}` }
            : { subtitle: "Runs on its own, on a schedule you set" })}
          onClose={() => setEditingCron(null)}
        >
          {editingCron && (
            <CronEditor
              {...(editingCron.job ? { job: editingCron.job } : {})}
              hooks={status?.hooks === true}
              onDone={() => {
                setEditingCron(null);
                void refresh();
              }}
              onCancel={() => setEditingCron(null)}
              onRunNow={(id) => {
                const job = crons.find((c) => c.id === id);
                setEditingCron(null);
                void runCronNow(id, job?.name ?? `cron #${id}`);
              }}
              onToggle={(id, enabled) => {
                setEditingCron(null);
                void api
                  .setCronEnabled(id, enabled)
                  .then(() => refresh())
                  .catch((err: unknown) =>
                    flash("err", err instanceof Error ? err.message : String(err)),
                  );
              }}
              onDelete={(id) => {
                setEditingCron(null);
                void api
                  .deleteCron(id)
                  .then(() => {
                    flash("ok", "Deleted");
                    return refresh();
                  })
                  .catch((err: unknown) =>
                    flash("err", err instanceof Error ? err.message : String(err)),
                  );
              }}
            />
          )}
        </Drawer>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          ctx={paletteContext}
        />
      </main>
      <QuickAsk
        open={askOpen}
        onClose={() => setAskOpen(false)}
        onOpen={openConversation}
        {...(askSeed ? { seed: askSeed } : {})}
        {...(askContext
          ? {
              contextId: askContext,
              contextTitle: conversations.find((c) => c.id === askContext)?.title ?? askContext,
            }
          : {})}
      />
      </div>
    </ErrorBoundary>
  );

  // —— agent page ——
  if (route.name === "page") {
    /*
     * Back to where the page belongs, not to Home.
     *
     * A page is opened from its project, and the only way out was a link
     * saying Home: two clicks to get back to the list you came from, every
     * time. A page belongs to a project, so that is where back goes.
     */
    const owner = [...pagesByProject.values()].some((list) =>
      list.some((pg) => pg.id === route.id),
    );
    const back: Route = owner ? { name: "projects" } : { name: "home" };
    return shell(
      <>
        <a
          className="ops-back"
          href={hrefFor(back)}
          onClick={(e) => {
            e.preventDefault();
            go(back);
          }}
        >
          {owner ? "← Projects" : "← Home"}
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
        projects={projects}
        {...(route.id ? { activeId: route.id } : {})}
        pendingApprovals={pendingIds}
        approvals={approvals}
        deciding={deciding}
        agents={agents}
        onOpenAgent={(id) => go({ name: "agents", id })}
        onOpen={openConversation}
        onOpenProject={(slug) => go({ name: "project", slug })}
        onAside={askAside}
        onChanged={() => void refresh()}
        onDecide={decideByPendingId}
        {...(seed ? { seed } : {})}
      />,
    );
  }

  if (route.name === "project") {
    /*
     * A project is a chat page of its own: its orchestrator in the middle,
     * its agents in the rail, and its files, pages and tables beside the
     * thread. The orchestrator is the thread by default.
     */
    const slug = route.slug;
    return shell(
      <ChatsPage
        conversations={conversations}
        projects={projects}
        activeId={route.id ?? `project:${slug}`}
        pendingApprovals={pendingIds}
        approvals={approvals}
        deciding={deciding}
        agents={agents}
        onOpenAgent={(id) => go({ name: "agents", id })}
        onOpen={openConversation}
        onOpenProject={(s) => go({ name: "project", slug: s })}
        project={{
          slug,
          onBack: () => go({ name: "chats" }),
          onOpenPage: openPage,
          onOpenFile: (path) => go({ name: "files", path }),
          onError: (text) => flash("err", text),
        }}
        onAside={askAside}
        onChanged={() => void refresh()}
        onDecide={decideByPendingId}
        {...(seed ? { seed } : {})}
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
      <RunsTabs current="agents">
        <AgentsPage
          deciding={deciding}
          onDecide={(id, approved, remember) => void decide(id, approved, remember)}
          {...(route.id !== undefined ? { openId: route.id } : {})}
        />
      </RunsTabs>,
    );
  }

  if (route.name === "settings") {
    return shell(
      <SettingsPage
        section={route.section}
        onSection={(section) => go({ name: "settings", section })}
      />,
    );
  }

  if (route.name === "projects") {
    return shell(
      <ProjectsPage
        projects={projects}
        pagesByProject={pagesByProject}
        conversations={conversations}
        onOpen={(slug) => go({ name: "project", slug })}
        onInspect={(project, pages) =>
          setInspect({ kind: "project", data: project, pages })
        }
      />,
    );
  }

  if (route.name === "history") {
    return shell(
      <RunsTabs current="history">
        <HistoryPage
          tools={activity}
          runs={runs}
          crons={crons}
          onOpenTool={(t) => setInspect({ kind: "tool", data: t })}
          onOpenRun={(r) => setInspect({ kind: "run", data: r })}
          onFix={(row) => void startFix(row)}
        />
      </RunsTabs>,
    );
  }

  if (route.name === "crons") {
    const rows = crons.filter((c) => {
      if (cronFilter === "on") return c.enabled;
      if (cronFilter === "off") return !c.enabled;
      return true;
    });
    return shell(
      <RunsTabs current="crons">
      <ListPage
        title="Schedule"
        subtitle="Jobs KOS runs on its own. Click a row to edit it."
        rows={rows}
        rowKey={(c) => c.id}
        empty="No crons match"
        onRowClick={(c) => setEditingCron({ job: c })}
        toolbar={
          /* Writing one by hand: everything here could be asked for in a
             sentence, but a schedule runs while nobody is watching, so it is
             worth being able to read exactly what will happen. Sat among the
             filters it read as one of them. */
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setEditingCron({})}
          >
            New schedule
          </button>
        }
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
            render: (c) => (
              <>
                {/* Whether a schedule is armed and whether it is busy are two
                    facts, and showing "running" instead of "on" lost the
                    first: a job could be running while switched off, and the
                    row said only that it was running. */}
                {c.enabled ? (
                  <span className="ops-tag ops-tag--ok">on</span>
                ) : (
                  <span className="ops-tag ops-tag--danger">off</span>
                )}
                {c.running && <span className="ops-tag ops-tag--run">running</span>}
              </>
            ),
          },
          {
            /* Where the job's runs live. Each one is a turn in a thread of
               its own, so this opens what it is doing now and what it did
               last week, and the owner can ask it there. */
            key: "runs",
            header: "Runs",
            searchText: () => "",
            render: (c) =>
              c.conversationId ? (
                <button
                  type="button"
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    go({ name: "chats", id: c.conversationId! });
                  }}
                >
                  {c.running ? "Watch" : "Open"}
                </button>
              ) : (
                <span className="ops-muted">not yet run</span>
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
          {
            // Whether a job works was otherwise answerable only by waiting for
            // its schedule, which for a nightly job is a day per attempt.
            key: "run",
            header: "",
            render: (c) => (
              <button
                type="button"
                className="btn btn--sm"
                disabled={firing === c.id}
                onClick={(e) => {
                  e.stopPropagation();
                  void runCronNow(c.id, c.name);
                }}
              >
                {firing === c.id ? "Running…" : "Run now"}
              </button>
            ),
          },
        ]}
      />
      </RunsTabs>,
    );
  }

  if (route.name === "inbox") {
    return shell(
      <InboxPage
        data={inbox}
        deciding={deciding}
        onDecide={(id, approved, remember) => void decide(id, approved, remember)}
        onOpenChat={(id) => go({ name: "chats", id })}
        onDismissFailure={(key) => void dismissFailure(key)}
        onOpenFailure={(key) => openFailure(key)}
        onFixFailure={fixFailure}
        onChanged={() => void refresh()}
      />,
    );
  }

  if (route.name === "memory") {
    return shell(
      <MemoryPage
        facts={facts}
        tags={factTags}
        conversations={conversations}
        onChanged={() => void refresh()}
      />,
    );
  }

  return shell(
    <HomePage
      onOpenChat={(id) => go({ name: "chats", id })}
      onGo={(to, section) => go({ name: to, ...(section ? { section } : {}) } as Route)}
      deciding={deciding}
      onDecide={(id, approved, remember) => void decide(id, approved, remember)}
      onDismissFailure={(key) => void dismissFailure(key)}
      onOpenFailure={(key) => openFailure(key)}
      onFixFailure={fixFailure}
    />,
  );
}



