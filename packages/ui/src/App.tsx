import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentFaces, ChatIcon, Chips, ease, faceDataUrl, IconButton, KOS_SEED, KosLook, lookOf, NotFound, overlayScroll, pageArrive, sheetOpen, StatusPill, When } from "@kos/kit";
import { errorWords, momentWords, slugWords, timeCard } from "@kos/shared";

import {
  type FailingJob,
  api,
  type AuditRecord,
  type BrowserTabInfo,
  type BuildRecord,
  type CronJob,
  type FactRow,
  type AnyPagePayload,
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
import { m } from "motion/react";

import { chatShown, frameOf, hrefFor, pageKeyOf, parseRoute, type Route } from "./routes.js";
import { Drawer } from "./Drawer.js";
import { targetHref, useCreateParam } from "./hashparams.js";
import { CronEditor } from "./CronEditor.js";
import { scheduleWords } from "./schedule.js";
import { HistoryPage, type HistoryRow } from "./HistoryPage.js";
import { HomePage } from "./HomePage.js";
import { ChatsPage } from "./ChatsPage.js";
import { BrowserWindow } from "./BrowserWindow.js";
import { OpenTab } from "./opentab.js";
import { DashboardRefs } from "./refs.js";
import { QuickAsk } from "./QuickAsk.js";
import { browsingNow, useProgress } from "./progress.js";
import { FilesPage } from "./FilesPage.js";
import { fileMention } from "./finder/model.js";
import { AgentsPage } from "./AgentsPage.js";
import { BuildsPage } from "./BuildsPage.js";
import { SettingsPage } from "./SettingsPage.js";
import { chooseTheme, heardDrawnTheme, reconcileTheme, reportDrawnTheme, themeStamp } from "./theme.js";
import { ProjectsPage } from "./ProjectsPage.js";
import { ArtifactViewer, ArtifactsPage, chatOf, chatOpen, settleOpenViewers } from "./ArtifactsPage.js";
import { placeOf } from "./chattree.js";
import { MemoryPage } from "./MemoryPage.js";
import { SecretsPage } from "./SecretsPage.js";
import { InboxPage } from "./InboxPage.js";
import { RUNS_SUBTITLE, RunsTabs } from "./RunsTabs.js";
import { Sidebar } from "./Sidebar.js";
import { WidgetPage } from "./WidgetPage.js";
import { CommandPalette, type PaletteContext } from "./CommandPalette.js";
import { ErrorBoundary } from "./widgets/ErrorBoundary.js";
import { Refreshes } from "./refreshes.js";
import { HostBanner } from "./HostBanner.js";
import { toast, ToastHost, type ToastTone } from "./Toast.js";
import { KeysSheet } from "./KeysSheet.js";
import { isLooseKey } from "./shortcuts.js";
import { useReach } from "./reach.js";
import { jobTitle, lastRunWords } from "./schedulewords.js";


/** The poll's feeds a page waits on before it may say it is empty. */
type Feed = "projects" | "crons" | "activity" | "memory" | "runs" | "conversations";

/** "3 tables", "1 chat": a count with its noun. */
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function App(): React.ReactElement {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  const [status, setStatus] = useState<Status | null>(null);
  // Whether KOS is answering this tab, and whether the page is from an earlier boot.
  const reach = useReach();
  /** Where the owner's theme choices here stood when the status shown was asked for. */
  const statusStamp = useRef(0);
  // The page's own scrolling, the main column's on most pages, under the overlay thumb the chats and settings panes have.
  useEffect(() => overlayScroll(document.documentElement), []);
  const [approvals, setApprovals] = useState<PendingAction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  /** Whether the manifest has been read yet: before it, no slug can be said to be no project. */
  // Which feeds have answered once: a page says it is empty only after its feed has, and shows where its rows will be before.
  const [read, setRead] = useState<ReadonlySet<Feed>>(() => new Set());
  const projectsRead = read.has("projects");
  /** Projects by slug, from the manifest, for the Memory page's scope headings. */
  const projectNames = useMemo(() => (projectsRead ? new Map(projects.map((p) => [p.slug, p.name])) : undefined), [projects, projectsRead]);
  const [crons, setCrons] = useState<CronJob[]>([]);
  /** The job being run by hand, so its own button can say so. */
  const [firing, setFiring] = useState<number | null>(null);
  /** A message the harness sent, until the transcript has it. */
  const [seed, setSeed] = useState<{ id: string; text: string } | null>(null);
  /** Words for a chat's composer, from asking about a file on the Files page. */
  const [compose, setCompose] = useState<{ text: string; n: number } | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [activity, setActivity] = useState<AuditRecord[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [factTags, setFactTags] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** Pending actions being decided right now. */
  const [deciding, setDeciding] = useState<ReadonlySet<number>>(new Set());
  const [activePage, setActivePage] = useState<AnyPagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [cronFilter, setCronFilter] = useState<"all" | "on" | "off">("all");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The quick-question window: the sidebar entry or Cmd/Ctrl+Shift+K. */
  const [askOpen, setAskOpen] = useState(false);
  /*
   * The browser window: opened by hand from the sidebar, or on its own the
   * moment KOS starts a browser step, so you catch the first page. Closing
   * it while KOS is still browsing keeps it shut for that turn.
   */
  const [browserOpen, setBrowserOpen] = useState(false);
  /** The browser's tabs as of the last poll, so a chip in a chat can name one. */
  const [browserTabs, setBrowserTabs] = useState<BrowserTabInfo[]>([]);
  /** A tab asked for from a chip or a button: the window opens on it. */
  const [browserPick, setBrowserPick] = useState<{ tab: string; n: number } | undefined>(undefined);
  const browserDismissed = useRef(false);
  /** Opened by the owner (a key, a button), so the keys go to it; opened on its own as KOS browses, they stay where they are. */
  const browserByHand = useRef(false);
  const live = useProgress();
  const openTab = useCallback((tab: string): void => {
    browserDismissed.current = false;
    browserByHand.current = true;
    setBrowserPick({ tab, n: Date.now() });
    setBrowserOpen(true);
  }, []);
  /** Who is browsing in KOS's own browser right now, and what they are doing, if anyone is. */
  const browsing = useMemo(() => browsingNow(live), [live]);
  /** Agents waiting for the owner's hands on their tab: the window opens itself for those. */
  const handoffs = useMemo(
    () =>
      approvals
        // A handoff in the owner's Chrome is theirs already: KOS's window has nothing of it to show.
        .filter((a) => a.tool === "browser.handoff" && !a.yours)
        .map((a) => {
          let reason = "";
          try {
            const parsed = JSON.parse(a.args) as { reason?: unknown };
            reason = typeof parsed.reason === "string" ? parsed.reason : "";
          } catch {
            /* the args are shown elsewhere */
          }
          return { id: a.id, conversationId: a.conversationId, reason };
        }),
    [approvals],
  );
  useEffect(() => {
    if ((browsing || handoffs.length > 0) && !browserDismissed.current) {
      setBrowserOpen((was) => {
        if (!was) browserByHand.current = false;
        return true;
      });
    }
    if (!browsing && handoffs.length === 0) browserDismissed.current = false;
  }, [browsing, handoffs.length]);
  /** A question typed as `/btw` in a chat, handed to the window to ask. */
  const [askSeed, setAskSeed] = useState<{ text: string; n: number } | null>(null);
  const askAside = (text: string): void => {
    setAskSeed({ text, n: Date.now() });
    setAskOpen(true);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        // Read inside the update: this handler is bound once.
        browserByHand.current = true;
        setBrowserOpen((v) => {
          browserDismissed.current = v;
          return !v;
        });
        return;
      }
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
  const [editingCron, setEditingCron] = useState<{ job?: CronJob; projectSlug?: string } | null>(null);
  // A schedule linked to by name (#/schedule/<name>, where an @schedule:
  // chip points) opens its drawer once the jobs are known, so a chat or a
  // blob can refer to a job and the owner lands on it rather than the list.
  useEffect(() => {
    if (route.name !== "crons" || !route.job) return;
    const want = route.job.trim().toLowerCase();
    const job = crons.find((c) => c.name.toLowerCase() === want || String(c.id) === want);
    if (job) setEditingCron({ job });
  }, [route, crons]);
  // New schedule from the palette: the Schedule page with `?new` on its address.
  useCreateParam(() => setEditingCron({}), route.name === "crons");
  /** The schedule's drawer shut, and its address with it, so the next read of the jobs does not open it again. */
  const closeCron = (): void => {
    setEditingCron(null);
    if (route.name === "crons" && route.job) window.location.hash = hrefFor({ name: "crons" });
  };
  const [conversations, setConversations] = useState<Conversation[]>([]);
  /** KOS's own look, from the status: every face of KOS and the tab icon use it. */
  const kosLook = useMemo(() => lookOf(KOS_SEED, status?.face ?? {}), [status?.face]);
  /** What the owner set about each agent's face, by role, for faces drawn from a name alone. */
  const agentFaces = useMemo(
    () => new Map(conversations.filter((c) => c.role && c.face).map((c) => [c.role!, c.face!])),
    [conversations],
  );
  // The workspace's theme, as every device that follows the dashboard draws it, is this tab's too, unless the owner chose since.
  useEffect(() => {
    if (!status) return;
    heardDrawnTheme(status.drawn);
    reconcileTheme(status.theme, (theme) => void api.saveTheme(theme).catch(() => undefined), statusStamp.current);
  }, [status]);
  // The palette this tab draws in is what a device set to the dashboard draws: KOS is told it when it changes, and when this tab is looked at again while KOS has another.
  useEffect(() => reportDrawnTheme(api.saveDrawnTheme), []);
  // The tab icon is KOS's face, still, with a mark when something waits.
  useEffect(() => {
    const mood = (status?.pendingApprovals ?? 0) > 0 ? "needs-you" : status?.halted ? "asleep" : "idle";
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href = faceDataUrl(kosLook, mood);
  }, [kosLook, status?.pendingApprovals, status?.halted]);

  /** A note in the one toast queue: its own id and timer, so the same words twice show twice; a refusal in the owner's words, never a store's or a tool's own message. */
  const flash = (kind: ToastTone, text: string): void => void toast({ kind, text: kind === "err" ? errorWords(text) : text });

  /**
   * One poll feeds the whole dashboard. Settled rather than all: under
   * Promise.all a single failing endpoint rejected the batch and froze every
   * panel, so one slow query could leave a decided approval on screen for as
   * long as it kept failing. Each result is applied on its own.
   */
  const refreshes = useRef(new Refreshes()).current;
  const refresh = useCallback(async () => {
    const run = refreshes.begin();
    const apply = <T,>(r: PromiseSettledResult<T>, set: (v: T) => void): void => {
      if (r.status === "fulfilled") set(r.value);
    };
    // One fewer request than this used to make: the failures-only view was a
    // separate fetch, and History filters the rows it already has.
    const stamp = themeStamp();
    const settled = await Promise.allSettled([
      api.status(),
      api.approvals(),
      api.projects(),
      api.crons(),
      api.pages(),
      api.activity(200),
      api.memory(300),
      api.runs(200, false),
      api.conversations(),
      api.builds(),
      api.inbox(),
      api.browserStatus(),
    ] as const);
    run.end();
    // A later refresh (decide's, say) has answered already: what this one read is older.
    if (!run.newest()) return;
    const [s, a, p, c, pg, act, mem, r, convos, ag, ib, br] = settled;
    const answered = (
      [
        ["projects", p],
        ["crons", c],
        ["activity", act],
        ["memory", mem],
        ["runs", r],
        ["conversations", convos],
      ] as const
    )
      .filter(([, got]) => got.status === "fulfilled")
      .map(([feed]) => feed);
    setRead((prev) => (answered.every((f) => prev.has(f)) ? prev : new Set([...prev, ...answered])));
    apply(s, (v) => {
      statusStamp.current = stamp;
      setStatus(v);
    });
    apply(ib, setInbox);
    apply(br, (v) => setBrowserTabs(v.tabs));
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
  }, [refreshes]);

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
      // Hidden, or the last one still out: a slow KOS is not sent another twelve requests on top.
      if (document.visibilityState === "hidden" || refreshes.busy) return;
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
  }, [refresh, refreshes]);

  // Read once: the port sites are served on is a property of how the host was
  // started, not something that changes while the page is open.
  useEffect(() => {
    void api
      .sites()
      .then((r) => setSitesBase(r.base))
      .catch(() => undefined);
  }, []);

  /** The "?" sheet of every key there is. */
  const [keysOpen, setKeysOpen] = useState(false);
  // The page's own keys, pressed with nothing to type into: "?" lists every key there is, "/" goes to the page's search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !isLooseKey(e) || sheetOpen()) return;
      if (e.key === "?") {
        e.preventDefault();
        setKeysOpen(true);
      } else if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>(".ops-page .search-field-input");
        if (!search) return;
        e.preventDefault();
        search.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    // An open artifact finishes its editing before the route moves on, however the move was made (a link, Back, a button): each viewer is capped as settle is.
    let moves = 0;
    const sync = (): void => {
      const move = ++moves;
      void settleOpenViewers().then(() => {
        if (move === moves) show(parseRoute(window.location.hash));
      });
    };
    const show = (next: Route): void => {
      setRoute(next);
      if (next.name === "page") {
        setPageError(null);
        setActivePage(null);
        void api
          .anyPage(next.id)
          .then((payload) => setActivePage(payload))
          .catch((err: unknown) => {
            setPageError(err instanceof Error ? err.message : String(err));
          });
      }
    };
    show(parseRoute(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const pagesByProject = useMemo(() => {
    const map = new Map<string, PageSummary[]>();
    for (const pg of pages) {
      if (pg.projectSlug === null) continue;
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

  const decide = async (id: number, approved: boolean, remember = false, code?: string): Promise<void> => {
    // Tracked per id rather than as one busy flag, so a second approval
    // pending elsewhere is not disabled by this one, and every copy of the
    // buttons for this action agrees about what is happening.
    setDeciding((current) => new Set(current).add(id));
    setBusy(approved ? `approving #${id}` : `denying #${id}`);
    try {
      const res = await (approved ? api.approve(id, remember, code) : api.deny(id));
      // The agent's continuation shows in the conversation it belongs to,
      // which Chats is already watching; there is no panel to echo it into.
      // The server's own line when there is one: it says when the chat is
      // held for another decision still waiting.
      // Asked to remember one that keeps nothing: said, and never called remembered.
      const kept = remember && !("remembered" in res && res.remembered === false);
      // The decision stood, and the chat that asked could not carry on from it: said in the warn tone, apart.
      if (res.resumed === false) {
        flash("warn", `${approved ? "Approved" : "Denied"} #${id}. The chat could not carry on: ${res.resumeError ?? "it stopped"}`);
        await refresh();
        return;
      }
      // A no is said in the quiet tone: the green check is for what was done, not for what was refused.
      flash(approved ? "ok" : "info", remember && !kept ? `Approved #${id}; nothing to remember for this one` : res.reply ? res.reply.slice(0, 120) : res.message ? res.message.slice(0, 160) : approved ? (kept ? `Approved #${id}, and remembered` : `Approved #${id}`) : `Denied #${id}`);
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
      flash(status.halted ? "ok" : "info", status.halted ? "Resumed" : "Halted");
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
            } with a history of their own left out`
          : "";
      flash("ok", res.sha ? `Backed up the workspace${omitted}` : `Nothing changed since the last backup${omitted}`);
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
      go({ name: "builds", id: agentId });
    },
    sitesBase,
    quickAsk: () => setAskOpen(true),
    openBrowser: () => {
      browserDismissed.current = false;
      browserByHand.current = true;
      setBrowserOpen(true);
    },
    setTheme: (theme) => void chooseTheme(theme, api.saveTheme).catch((err: unknown) => flash("err", `Not saved to KOS: ${err instanceof Error ? err.message : String(err)}`)),
    showKeys: () => setKeysOpen(true),
    openTarget: (target) => {
      const href = targetHref(target, (id) => placeOf(id, conversations.find((c) => c.id === id)));
      if (href) {
        window.location.hash = href;
        return;
      }
      // A run or a call: its record, over Runs, as a row there opens it.
      go({ name: "history" });
      const failed = (err: unknown): void => flash("err", err instanceof Error ? err.message : String(err));
      if (target.kind === "run") void api.run(target.id).then((r) => r && openInspect({ kind: "run", data: r }, pageKeyOf({ name: "history" }))).catch(failed);
      else if (target.kind === "call") void api.call(target.id).then((t) => openInspect({ kind: "tool", data: t }, pageKeyOf({ name: "history" }))).catch(failed);
    },
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

  const decideByPendingId = (pendingId: string, approved: boolean, remember = false, code?: string): void => {
    const id = Number(pendingId);
    if (Number.isInteger(id)) void decide(id, approved, remember, code);
  };

  // A drawer belongs to the page it was opened over: leaving the page shuts it.
  const pageKey = pageKeyOf(route);
  /** The page the open record belongs to: the one it was opened on, or the one it was opened for (a run from search, over Runs). */
  const inspectPage = useRef<string | null>(null);
  const openInspect = (target: InspectTarget, page = pageKey): void => {
    inspectPage.current = page;
    setInspect(target);
  };
  useEffect(() => {
    if (inspectPage.current !== null && inspectPage.current !== pageKey) setInspect(null);
  }, [pageKey]);
  // Arrived on a page, the keys go with you rather than back to the top of the document: a chat's box, else the page's region.
  useEffect(() => {
    let tries = 0;
    let frame = 0;
    const land = (): void => {
      const at = document.activeElement;
      if (at && at !== document.body && at.isConnected && !at.matches("[data-focus-home]")) return;
      const box = document.querySelector<HTMLElement>(".ops-page .chats-composer textarea:not(:disabled)");
      if (box) box.focus({ preventScroll: true });
      // A chat's box comes with its thread, a moment after the page.
      else if (chatShown(route) && ++tries < 30) frame = requestAnimationFrame(land);
      else document.querySelector<HTMLElement>("[data-focus-home]")?.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(land);
    return () => cancelAnimationFrame(frame);
  }, [pageKey]);
  /** What the drawer shows, kept while it shuts so it leaves with what it held. */
  const lastInspect = useRef<string | null>(null);
  const inspectKey =
    inspect == null
      ? lastInspect.current
      : inspect.kind === "tool"
        ? `tool-${inspect.data.id}`
        : inspect.kind === "run"
          ? `run-${inspect.data.id}`
          : `project-${inspect.data.slug}`;
  lastInspect.current = inspectKey;

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
  /** An empty project, from the Projects page or the Chats rail; it opens once made. */
  const createProject = async ({ name, type }: { name: string; type: string }): Promise<void> => {
    const made = await api.createProject(name, type);
    flash("ok", `Made ${made.name}`);
    await refresh();
    go({ name: "project", slug: made.slug });
  };
  /** Delete a project wherever it was asked from; a page that was showing it leaves it. */
  const deleteProject = async (slug: string): Promise<void> => {
    // A refusal (its trash has nowhere to go) is said wherever it was asked from, a menu included.
    const gone = await api.deleteProject(slug).catch((err: unknown) => {
      flash("err", err instanceof Error ? err.message : String(err));
      throw err;
    });
    setInspect(null);
    const name = projects.find((p) => p.slug === slug)?.name ?? slugWords(slug);
    const kept = gone.trashKept ? `; what was in its trash is in the workspace's trash` : "";
    flash("ok", `Deleted ${name}: ${count(gone.tablesDropped.length, "table")}, ${count(gone.pagesRemoved, "artifact")}; ${count(gone.conversationsArchived, "chat")} archived, ${count(gone.jobsDisabled, "schedule")} off${kept}`);
    if (route.name === "project" && route.slug === slug) go({ name: "chats" });
    await refresh();
  };
  /** The thread the quick question is asked beside, if one is open. */
  const askContext = chatShown(route);

  const shell = (body: React.ReactNode): React.ReactElement => (
    <ErrorBoundary label="dashboard">
      {/* The chat route owns the whole window: the shell's scroll padding is
          for pages that scroll, and with it the document ran past the viewport
          so the page moved behind the chat, top bar and all. */}
      <OpenTab.Provider value={openTab}>
      <DashboardRefs>
      <KosLook.Provider value={kosLook}>
      <AgentFaces.Provider value={agentFaces}>
      <div className="app">
      <Sidebar
        route={route}
        status={status}
        down={reach.down}
        inboxCount={inbox ? inbox.approvals.length + inbox.decisions.length + inbox.failures.length + inbox.suggestions.length : approvals.length}
        busy={busy}
        onSearch={() => setPaletteOpen(true)}
        onAsk={() => setAskOpen((v) => !v)}
        onBrowser={() => {
          browserDismissed.current = browserOpen;
          browserByHand.current = true;
          setBrowserOpen((v) => !v);
        }}
        browsing={browsing !== null}
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
      <main className="ops" tabIndex={-1} data-focus-home>
        <HostBanner reach={reach} />
        <ToastHost />
        {/* Keyed on what it shows, and still keyed on it while it shuts, so
            the drawer leaves with what it held rather than vanishing. */}
          <Inspector
            key={inspectKey ?? "none"}
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
            onUpdateProject={async (slug, patch) => {
              await api.updateProject(slug, patch);
              await refresh();
            }}
            onSetProjectColour={async (slug, colour) => {
              await api.setProjectColour(slug, colour);
              await refresh();
            }}
            onSetProjectStatus={async (slug, st) => {
              await api.setProjectStatus(slug, st);
              flash("ok", `Project ${slug} → ${st}`);
              await refresh();
            }}
            onDeleteProject={deleteProject}
          />

        {/* A page arriving. Keyed on the route so switching tabs is a change
            the eye can follow, but never a frame with no page in it: the old
            page goes at once and the new one is there from its first frame,
            settling with the one ease (a fade from most of the way and an
            8 px rise). Nothing waits on it. The page carries its own frame
            (a reading width and gutter, or the chat's full bleed). */}
        <m.div
          key={pageKeyOf(route)}
          className={`ops-page ops-page--${frameOf(route)}${route.name === "files" ? " ops-page--files" : route.name === "settings" ? " ops-page--split" : ""}`}
          initial={pageArrive.initial}
          animate={pageArrive.animate}
          transition={ease}
        >
          {body}
        </m.div>

        {/* A drawer: a schedule has a name, a cron line, a type and a body
            of actions, which is more than a dialog in the middle of the page
            should be asked to hold. */}
        <Drawer
          open={editingCron !== null}
          title={editingCron?.job ? jobTitle(editingCron.job.name) : "New schedule"}
          subtitle={editingCron?.job ? scheduleWords(editingCron.job.schedule) : "Pick when it runs and what it does"}
          onClose={closeCron}
        >
          {editingCron && (
            <CronEditor
              onNotice={(text) => flash("ok", text)}
              projects={projects.filter((p) => p.status === "active").map((p) => ({ slug: p.slug, name: p.name }))}
              {...(editingCron.projectSlug ? { defaultProject: editingCron.projectSlug } : {})}
              {...(editingCron.job ? { job: editingCron.job } : {})}
              taken={crons.filter((c) => c.id !== editingCron.job?.id).map((c) => c.name)}
              hooks={status?.hooks === true}
              onDone={() => {
                closeCron();
                void refresh();
              }}
              onCancel={closeCron}
              onRunNow={(id) => {
                const job = crons.find((c) => c.id === id);
                closeCron();
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
        <KeysSheet open={keysOpen} onClose={() => setKeysOpen(false)} />
      </main>
      <BrowserWindow
        open={browserOpen}
        grab={browserByHand.current}
        onClose={() => {
          browserDismissed.current = true;
          setBrowserOpen(false);
        }}
        {...(browsing?.doing ? { doing: browsing.doing } : {})}
        {...(handoffs[0]?.conversationId ? { prefer: handoffs[0].conversationId } : browsing ? { prefer: browsing.id } : {})}
        {...(browserPick ? { pick: browserPick } : {})}
        titleFor={(id) => conversations.find((c) => c.id === id)?.title}
        handoffs={handoffs}
        onDecide={(id, approved) => void decide(id, approved)}
      />
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
      </AgentFaces.Provider>
      </KosLook.Provider>
      </DashboardRefs>
      </OpenTab.Provider>
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
    // An HTML artifact is shown as the Artifacts viewer shows it: one head, its versions in a drawer, drawn as part of the page.
    if (activePage?.kind === "html") {
      return shell(
        <ArtifactViewer
          key={route.id}
          id={route.id}
          initial={activePage}
          projects={projects}
          backTo={owner ? "Projects" : "Home"}
          onBack={() => go(back)}
          onOpenChat={(owner) => void chatOf(owner).then(go)}
          onOpenOwner={(owner) => void chatOf(owner).then(go)}
        />,
      );
    }
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
          <WidgetPage
            page={activePage}
            projects={projects}
            onReload={() => api.anyPage(activePage.record.id).then(setActivePage)}
            onGone={() => go(back)}
            onError={(text) => flash("err", text)}
          />
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
        loading={!read.has("conversations") || !read.has("projects")}
        {...(route.id ? { activeId: route.id } : {})}
        composing={route.compose === true}
        pendingApprovals={pendingIds}
        approvals={approvals}
        deciding={deciding}
        agents={agents}
        tabs={browserTabs}
        onOpenAgent={(id) => go({ name: "builds", id })}
        onOpen={openConversation}
        onOpenProject={(slug) => go({ name: "project", slug })}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        crons={crons}
        onEditCron={(job, projectSlug) => setEditingCron(job ? { job } : { ...(projectSlug ? { projectSlug } : {}) })}
        onAside={askAside}
        onNotice={(text) => flash("ok", text)}
        onChanged={() => void refresh()}
        onDecide={decideByPendingId}
        {...(seed ? { seed } : {})}
        {...(compose ? { compose, onComposed: () => setCompose(null) } : {})}
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
    // No such project: said in words with the way back, not a rail of chats to start in it.
    if (projectsRead && !projects.some((p) => p.slug === slug)) {
      return shell(<NotFound what="project" name={slug} back={{ label: "All projects", href: hrefFor({ name: "projects" }) }} />);
    }
    return shell(
      <ChatsPage
        conversations={conversations}
        projects={projects}
        loading={!read.has("conversations") || !read.has("projects")}
        activeId={route.id ?? `project:${slug}`}
        pendingApprovals={pendingIds}
        approvals={approvals}
        deciding={deciding}
        agents={agents}
        tabs={browserTabs}
        onOpenAgent={(id) => go({ name: "builds", id })}
        onOpen={openConversation}
        onOpenProject={(s) => go({ name: "project", slug: s })}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        project={{
          slug,
          onBack: () => go({ name: "chats" }),
          onOpenPage: openPage,
          onOpenFile: (path) => go({ name: "files", path }),
          onError: (text) => flash("err", text),
        }}
        crons={crons}
        onEditCron={(job, projectSlug) => setEditingCron(job ? { job } : { ...(projectSlug ? { projectSlug } : {}) })}
        onAside={askAside}
        onNotice={(text) => flash("ok", text)}
        onChanged={() => void refresh()}
        onDecide={decideByPendingId}
        {...(seed ? { seed } : {})}
      />,
    );
  }

  if (route.name === "artifacts") {
    return shell(
      route.id ? (
        <ArtifactViewer
          key={route.id}
          id={route.id}
          projects={projects}
          onBack={() => go({ name: "artifacts" })}
          onOpenChat={(owner) => void chatOf(owner).then(go)}
          onOpenOwner={(owner) => void chatOf(owner).then(go)}
        />
      ) : (
        <ArtifactsPage
          projects={projects}
          onOpen={(id) => go({ name: "artifacts", id })}
          onAsked={(owner) => void chatOf(owner).then(go)}
          onAskFailed={(owner, message) =>
            // A send the dialog could not say failed (it had handed over, or gone): a quiet toast, unless that chat is open to show it.
            void chatOpen(owner, parseRoute(window.location.hash)).then((open) => !open && flash("err", `Could not ask KOS: ${message}`))
          }
        />
      ),
    );
  }

  if (route.name === "files") {
    return shell(
      <FilesPage
        {...(route.path ? { path: route.path } : {})}
        onOpen={(p) => go({ name: "files", path: p })}
        onAsk={(paths) => {
          // A question about files goes to KOS's own chat, the files referenced in its composer.
          setCompose({ text: paths.map(fileMention).join(" "), n: Date.now() });
          const kosChat = conversations.find((c) => c.kind === "orchestrator");
          go(kosChat ? { name: "chats", id: kosChat.id } : { name: "chats" });
        }}
      />,
    );
  }

  if (route.name === "builds") {
    return shell(
      <BuildsPage
        deciding={deciding}
        onDecide={(id, approved, remember, code) => void decide(id, approved, remember, code)}
        {...(route.id !== undefined ? { openId: route.id } : {})}
      />,
    );
  }

  if (route.name === "blobs" && route.blob !== undefined && route.blob !== "new") {
    /*
     * An agent's own page: its thread in the middle, the chats it has in
     * projects in the rail, and its file and schedule beside the thread.
     * The same page a project gets, scoped to the agent instead.
     */
    const name = route.blob;
    return shell(
      <ChatsPage
        conversations={conversations}
        projects={projects}
        loading={!read.has("conversations") || !read.has("projects")}
        activeId={`agent:${name}`}
        pendingApprovals={pendingIds}
        approvals={approvals}
        deciding={deciding}
        agents={agents}
        tabs={browserTabs}
        onOpenAgent={(id) => go({ name: "builds", id })}
        onOpen={openConversation}
        onOpenProject={(s) => go({ name: "project", slug: s })}
        agent={{
          name,
          onBack: () => go({ name: "blobs" }),
          onOpenPage: openPage,
          onOpenFile: (path) => go({ name: "files", path }),
          onError: (text) => flash("err", text),
          onRemoved: () => {
            void refresh();
            go({ name: "blobs" });
          },
        }}
        crons={crons}
        onEditCron={(job, projectSlug) => setEditingCron(job ? { job } : { ...(projectSlug ? { projectSlug } : {}) })}
        onAside={askAside}
        onNotice={(text) => flash("ok", text)}
        onChanged={() => void refresh()}
        onDecide={decideByPendingId}
        {...(seed ? { seed } : {})}
      />,
    );
  }

  if (route.name === "blobs") {
    return shell(
      <AgentsPage
        {...(route.blob !== undefined ? { open: route.blob } : {})}
        onOpen={(blob) => go(blob ? { name: "blobs", blob } : { name: "blobs" })}
        onNotice={(text) => flash("ok", text)}
        onChanged={() => void refresh()}
      />,
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
        loading={!read.has("projects")}
        pagesByProject={pagesByProject}
        conversations={conversations}
        crons={crons}
        onInspect={(project, pages) =>
          openInspect({ kind: "project", data: project, pages })
        }
        onCreate={createProject}
      />,
    );
  }

  if (route.name === "history") {
    return shell(
      <HistoryPage
        tools={activity}
        loading={!read.has("activity") || !read.has("runs")}
        runs={runs}
        crons={crons}
        conversations={conversations}
        projects={projects}
        onOpenTool={(t) => openInspect({ kind: "tool", data: t })}
        onOpenRun={(r) => openInspect({ kind: "run", data: r })}
        onFix={(row) => void startFix(row)}
      />,
    );
  }

  if (route.name === "crons") {
    // Yours first, then KOS's own (kos.backup, kos.memory and the rest):
    // the two were interleaved by id, so the owner's three sat among six
    // of the system's and read as one list of nine.
    const system = (c: CronJob): boolean => c.name.startsWith("kos.");
    // A job whose project is gone keeps running under its slug; said so,
    // rather than shown as a project that cannot be opened.
    const projectName = (slug: string | null | undefined): string | undefined =>
      slug ? (projects.find((p) => p.slug === slug)?.name ?? `${slug} (no such project)`) : undefined;
    // Yours at the root, then each project's, then KOS's own. Digits, not
    // punctuation: "~" sorted before "0" under the locale and put the
    // system's first.
    // A blob's schedule is the blob's, not one of yours to arrange, so the
    // blobs' jobs stand together as KOS's own do.
    const blob = (c: CronJob): boolean => c.name.startsWith("blob.");
    const groupOf = (c: CronJob): string => (system(c) ? "KOS's upkeep" : blob(c) ? "Blobs" : (projectName(c.projectSlug) ?? "Yours"));
    const rank = (c: CronJob): string => (system(c) ? "3" : blob(c) ? "2" : c.projectSlug ? `1 ${groupOf(c)}` : "0");
    const rows = crons
      .filter((c) => {
        if (cronFilter === "on") return c.enabled;
        if (cronFilter === "off") return !c.enabled;
        return true;
      })
      .sort((a, b) => rank(a).localeCompare(rank(b)));
    return shell(
      <ListPage
        title="Runs"
        tabs={<RunsTabs current="crons" />}
        subtitle={RUNS_SUBTITLE.crons}
        stackOnPhone
        rows={rows}
        loading={!read.has("crons")}
        rowKey={(c) => c.id}
        empty="Nothing runs on its own yet."
        noun="schedules"
        onClearFilters={() => setCronFilter("all")}
        groupBy={groupOf}
        collapsible
        // The address says which job is open, so it can be sent or come
        // back to; closing the drawer takes it back off.
        onRowClick={(c) => {
          setEditingCron({ job: c });
          window.location.hash = hrefFor({ name: "crons", job: String(c.id) });
        }}
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
          <Chips options={([["all", "All"], ["on", "On"], ["off", "Off"]] as const)} selected={cronFilter} onChoose={setCronFilter} />
        }
        columns={[
          {
            key: "name",
            header: "Name",
            stack: "title",
            searchText: (c) => `${jobTitle(c.name)} ${c.name} ${c.schedule} ${c.type}`,
            render: (c) => (
              <span className="sched-name">
                {/* KOS's own jobs by the names the owner knows them by; the id is in the title. */}
                <span className="sched-title" title={c.name}>{jobTitle(c.name)}</span>
                <span className="sched-sub">
                  <span title={c.schedule}>{scheduleWords(c.schedule)}</span>
                  <span>{c.type === "self_prompt" ? "Asks KOS" : "Runs its steps"}</span>
                </span>
              </span>
            ),
          },
          {
            key: "state",
            header: "State",
            width: "7rem",
            searchText: (c) => (c.running ? "running" : c.enabled ? "on" : "off"),
            render: (c) => <StatusPill state={c.running ? "running" : c.enabled ? "on" : "off"} />,
          },
          {
            key: "next",
            header: "Next",
            stackLabel: true,
            width: "9rem",
            searchText: () => "",
            render: (c) =>
              c.enabled && c.nextRunAt ? (
                <span className={`sched-when${c.nextRunAt - Date.now() < 3_600_000 ? " sched-when--soon" : ""}`} title={timeCard(c.nextRunAt / 1000).join(" ")}>
                  {momentWords(c.nextRunAt)}
                </span>
              ) : (
                <span className="ops-muted">—</span>
              ),
          },
          {
            key: "last",
            header: "Last run",
            stackLabel: true,
            width: "10rem",
            searchText: () => "",
            // Words, not a link: the thread its runs are written into opens from the row's own button.
            render: (c) => <span className="ops-muted">{c.lastRunAt ? <When at={c.lastRunAt} /> : lastRunWords(null)}</span>,
          },
          {
            key: "project",
            header: "Project",
            stackLabel: true,
            width: "10rem",
            searchText: (c) => projectName(c.projectSlug) ?? "",
            render: (c) =>
              c.projectSlug ? (
                <span className="sched-project" title={c.projectSlug}>
                  {projectName(c.projectSlug)}
                </span>
              ) : (
                <span className="ops-muted">—</span>
              ),
          },
          {
            // Whether a job works was otherwise answerable only by waiting for
            // its schedule, which for a nightly job is a day per attempt.
            key: "run",
            header: "",
            stack: "aside",
            width: "8rem",
            render: (c) => (
              <span className="sched-acts">
                {/* Where its runs live: a thread of its own, what it is doing now and did last week. */}
                {c.conversationId && (
                  <IconButton
                    label="Open the thread its runs are written into"
                    onClick={(e) => {
                      e.stopPropagation();
                      go({ name: "chats", id: c.conversationId! });
                    }}
                  >
                    <ChatIcon title="" />
                  </IconButton>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={firing === c.id}
                  title="Fire it now, the way the schedule would"
                  onClick={(e) => {
                    e.stopPropagation();
                    void runCronNow(c.id, c.name);
                  }}
                >
                  {firing === c.id ? "Running…" : "Run now"}
                </button>
              </span>
            ),
          },
        ]}
      />,
    );
  }

  if (route.name === "inbox") {
    return shell(
      <InboxPage
        data={inbox}
        {...(route.id !== undefined ? { highlight: route.id } : {})}
        deciding={deciding}
        onDecide={(id, approved, remember, code) => void decide(id, approved, remember, code)}
        onOpenChat={(id) => go({ name: "chats", id })}
        onOpenBrowser={() => {
          browserDismissed.current = false;
          browserByHand.current = true;
          setBrowserOpen(true);
        }}
        onDismissFailure={(key) => void dismissFailure(key)}
        onOpenFailure={(key) => openFailure(key)}
        onFixFailure={fixFailure}
        onChanged={() => void refresh()}
      />,
    );
  }

  if (route.name === "secrets") {
    return shell(<SecretsPage conversations={conversations} />);
  }

  if (route.name === "memory") {
    return shell(
      <MemoryPage
        onNotice={(text) => flash("ok", text)}
        facts={facts}
        loading={!read.has("memory")}
        tags={factTags}
        {...(projectNames ? { projectNames } : {})}
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
      onDecide={(id, approved, remember, code) => void decide(id, approved, remember, code)}
      onDismissFailure={(key) => void dismissFailure(key)}
      onOpenFailure={(key) => openFailure(key)}
      onFixFailure={fixFailure}
    />,
  );
}

