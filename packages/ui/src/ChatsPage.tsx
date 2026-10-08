import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import { AnimatePresence, m } from "motion/react";
import { summarizeAction } from "@kos/shared";

import { Decision } from "./Decision.js";
import { VoiceInput } from "./VoiceInput.js";
import { ease, listItem, spring, stagger, card } from "./motion.js";
import { useDismiss } from "./useDismiss.js";

import { ContextMeter } from "./ContextMeter.js";
import { groupChats, isBusy, placeOf, projectSummary } from "./chattree.js";
import { Gutter } from "./Gutter.js";
import { ProjectPanel } from "./ProjectPanel.js";
import {
  api,
  type ChatEvent,
  type Conversation,
  type BuildRecord,
  type PendingAction,
  type PendingMessage,
  type Project,
} from "./api.js";
import { AttachButton, useAttachments, useDropZone } from "./Attachments.js";
import { AttachmentStrip } from "./AttachmentStrip.js";
import { ModelPicker } from "./ModelPicker.js";
import { HighlightedInput } from "./HighlightedInput.js";
import {
  applySuggestion,
  AutocompleteMenu,
  readTrigger,
  useSuggestions,
  type Suggestion,
  type Trigger,
} from "./Autocomplete.js";
import { Thinking } from "./Thinking.js";
import { MessageActions, MessageEditor } from "./MessageActions.js";
import {
  CopyIcon,
  EditIcon,
  ForkIcon,
  MoreIcon,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  PanelIcon,
} from "./icons.js";

import {
  clearProgress,
  settleProgress,
  seedProgress,
  useProgress,
  onNote,
  type Live,
} from "./progress.js";
import { LiveTurn } from "./LiveTurn.js";
import { ToolCall } from "./ToolCall.js";
import { ChatConfig } from "./ChatConfig.js";
import { Markdown, MentionNames } from "./Markdown.js";
import { Modal } from "./Modal.js";
import { hrefFor } from "./routes.js";
import { composerKeyDown, useAutoGrow, useStickToBottom } from "./composer.js";

/**
 * The chats page: a list that stays usable at fifty conversations, and the
 * selected one open beside it. Tabs in a slide-over stopped working somewhere
 * around five, which is why this exists as its own place rather than more
 * chrome bolted onto the panel.
 */

/** The page scoped to one project. See ChatsPageProps.project. */
export interface ProjectMode {
  slug: string;
  /** Out of the project, back to the chats. */
  onBack: () => void;
  onOpenPage: (id: string) => void;
  onOpenFile: (path: string) => void;
  onError: (message: string) => void;
}

export interface ChatsPageProps {
  conversations: Conversation[];
  /** Manifest projects, so the rail shows a project even before it has an orchestrator conversation. */
  projects: Project[];
  activeId?: string;
  /** Pending-action ids still awaiting a decision. */
  pendingApprovals: Set<string>;
  /**
   * Every action waiting on the owner, so this chat can show the ones that
   * belong to it but are not in its transcript: a build's own requests come
   * from a sub-agent, not from a tool call the conversation made.
   */
  approvals: PendingAction[];
  /** Actions being decided right now. */
  deciding: ReadonlySet<number>;
  /** Coding sub-agents, so a chat that started one can link to it. */
  agents: BuildRecord[];
  onOpenAgent: (id: number) => void;
  onOpen: (id: string) => void;
  /** A project row opens the project's workspace; its chat is one action from there. */
  onOpenProject: (slug: string) => void;
  /**
   * Project mode: the page is scoped to one project. The rail lists its
   * orchestrator and agents (nothing else), the view is whichever of those
   * is open, and a third column holds the project's files, pages and tables.
   */
  project?: ProjectMode;
  /** `/btw <question>`: ask it beside this chat, in the quick-question window. */
  onAside: (question: string) => void;
  /** A line of feedback shown briefly over the page: what a command just did. */
  onNotice: (text: string) => void;
  onChanged: () => void;
  onDecide: (pendingId: string, approved: boolean, remember?: boolean) => void;
  /**
   * A message handed to the server rather than typed here, shown until the
   * transcript has it. Without it a fix attempt opened on an agent thinking
   * about nothing, and the question it was answering appeared a minute later.
   */
  seed?: { id: string; text: string };
}

/** A tool's arguments as the owner can read them: the JSON laid out, or the string as it came. */
function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function relative(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function ChatsPage({
  conversations,
  projects,
  activeId,
  pendingApprovals,
  approvals,
  deciding,
  agents,
  onOpenAgent,
  onOpen,
  onOpenProject,
  project,
  onAside,
  onNotice,
  onChanged,
  onDecide,
  seed,
}: ChatsPageProps): ReactElement {
  const [query, setQuery] = useState("");
  /** A row's link: a project's thread links into the project, the rest into Chats. */
  const hrefOf = (c: Conversation): string => hrefFor(placeOf(c.id, c));
  const [events, setEvents] = useState<ChatEvent[]>([]);
  /**
   * A message the server was given directly, shown until the transcript
   * catches up. A fix attempt is started by the harness rather than typed
   * here, so the chat opened on an agent apparently thinking about nothing
   * and the question appeared a minute later when the turn recorded itself.
   */
  const seeded =
    seed &&
    seed.id === activeId &&
    !events.some((e) => e.kind === "message" && e.role === "you")
      ? ([{ kind: "message", role: "you", text: seed.text }] as ChatEvent[])
      : [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Which conversation is mid-send, not whether any is: shared across chats it
  // showed "sending" in every other thread while one was working.
  const [sendingIn, setSendingIn] = useState<string | null>(null);
  // Sent but not yet run. Read from the server rather than kept here, so a
  // reload still shows what was already taken.
  // Replies to slash commands, which are not in the transcript and were
  // therefore thrown away by the reload after sending: /help printed nothing
  // at all, and /clear emptied the chat without saying it had.
  const [notes, setNotes] = useState<{ id: number; text: string }[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  /** The queued message being rewritten, if any. */
  const [editingQueued, setEditingQueued] = useState<{ id: number; text: string } | null>(
    null,
  );
  const attachments = useAttachments();
  const progress = useProgress();

  // The list is the authority on what is running: a turn that started before
  // this view opened produced no events it could have seen, and one that
  // finished while the connection was down would otherwise stay on screen.
  useEffect(() => {
    seedProgress(
      conversations.filter((c) => c.activity === "working").map((c) => c.id),
    );
    for (const c of conversations) {
      const live = progress[c.id];
      if (!live || c.activity === "working") continue;
      // Nothing left to hand over, or nobody here to hand it to: a turn that
      // ended in a conversation the reader is not looking at has no transcript
      // to be swapped into.
      if (live.steps.length === 0 || (live.ended && c.id !== activeId)) {
        clearProgress(c.id);
      }
    }
  }, [conversations, progress, activeId]);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /*
   * On a phone there is no room for two panes. The list is the page until a
   * chat is open; then the chat is, and the list slides over it from the
   * toggle, closing again when a chat is picked.
   */
  const narrow = useNarrow();
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => setListOpen(false), [activeId]);
  useEffect(() => {
    if (!listOpen) return;
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setListOpen(false);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [listOpen]);
  const [showArchived, setShowArchived] = useState(false);
  /** The row whose Delete was pressed once; a second press deletes. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** A chat just archived from its header, offered back for a moment. */
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);
  /** What is typed on the landing, before there is a chat to put it in. */
  const [opening, setOpening] = useState("");
  /**
   * What the landing's Send does with what was typed:
   * - kos: hand it to KOS, which decides between a chat and a project.
   * - chat: a plain conversation that does the work itself.
   * - project: stand up a project and its orchestrator, with this as the goal.
   */
  const [mode, setMode] = useState<"kos" | "chat" | "project">("kos");
  const startFromLanding = async (): Promise<void> => {
    const text = opening.trim();
    if (!text || creating) return;
    setCreating(true);
    try {
      let id: string;
      if (mode === "kos") {
        id = (await api.orchestrator(text)).conversationId;
      } else if (mode === "project") {
        const name = text.split("\n")[0]!.slice(0, 48) || "New project";
        const r = await api.createProject(name);
        void api.message(text, r.conversationId).catch(() => undefined);
        id = r.conversationId;
      } else {
        const c = await api.newConversation();
        void api.message(text, c.id).catch(() => undefined);
        id = c.id;
      }
      setOpening("");
      onChanged();
      onOpen(id);
    } finally {
      setCreating(false);
    }
  };
  const [showScheduled, setShowScheduled] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  useEffect(() => {
    if (menuFor === null) setConfirmDelete(null);
  }, [menuFor]);
  /** The chat being renamed, with its title as the field starts. */
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(
    null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);
  useDismiss(menuRef, menuFor !== null, closeMenu);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [rewinding, setRewinding] = useState(false);
  const [archived, setArchived] = useState<Conversation[]>([]);

  // Fetched only when asked for: an archived chat is something you go looking
  // for, and there was no way to reach one at all.
  useEffect(() => {
    if (!showArchived) return;
    void api
      .conversations(true)
      .then((all) => setArchived(all.filter((c) => c.archived)))
      .catch(() => setArchived([]));
  }, [showArchived, conversations]);
  const drop = useDropZone((l) => void attachments.add(l));
  const live = activeId ? progress[activeId] : undefined;
  // A finished turn keeps its steps on screen until the transcript arrives,
  // so "there is a live view" and "work is happening" are no longer the same
  // question.
  const working = Boolean(live) && !live?.ended;
  const running = working || sendingIn === activeId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, draft);
  // Opening a chat puts the cursor in its box: that is what you came to do.
  useEffect(() => {
    if (activeId && !narrow) inputRef.current?.focus();
  }, [activeId, narrow]);

  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [acCursor, setAcCursor] = useState(0);
  /*
   * What the menu offers besides the index: inside a project its own files,
   * pages and agents come first, and /approve can name what is waiting.
   */
  const suggestionOptions = useMemo(() => {
    const slug = project?.slug ?? conversations.find((c) => c.id === activeId)?.projectSlug ?? undefined;
    return {
      ...(slug ? { project: slug } : {}),
      approvals: approvals.map((a) => ({
        id: a.id,
        label: a.reason ?? summarizeAction(a.tool, a.args),
        here: a.conversationId === activeId,
      })),
    };
  }, [project?.slug, conversations, activeId, approvals]);
  const suggestions = useSuggestions(trigger, suggestionOptions);

  const syncTrigger = (): void => {
    const el = inputRef.current;
    if (!el) return;
    setTrigger(readTrigger(el.value, el.selectionStart ?? el.value.length));
    setAcCursor(0);
  };

  const choose = (s: Suggestion): void => {
    const el = inputRef.current;
    if (!el || !trigger) return;
    const next = applySuggestion(el.value, trigger, s);
    setDraft(next.text);
    setTrigger(null);
    // Restored after React writes the value, or the caret jumps to the end.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };
  const boxRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId);
  /*
   * A turn is running here, on both accounts.
   *
   * The live view alone is not enough to hold the transcript still. A
   * turn-end that never arrives -- a dropped stream, a sleeping tab -- leaves
   * a live entry that no longer corresponds to anything, and keying only on
   * that would block every refresh from then on: a transcript frozen at
   * whatever it last held, which is the failure the holding was meant to
   * prevent. The list is the other account, and it comes from the server.
   */
  const turnRunningHere = working && active?.activity === "working";
  const visible = [...seeded, ...events];

  /**
   * The words for a reference, where this view knows them. A chat and an
   * agent are addressed by id, and an id is not a name.
   */
  const nameFor = (kind: string, id: string): string | undefined => {
    if (kind === "chat") return conversations.find((c) => c.id === id)?.title;
    if (kind === "agent") {
      const build = agents.find((b) => String(b.id) === id);
      return build ? build.dir : undefined;
    }
    return undefined;
  };

  /**
   * Reload on the conversation changing, and again whenever it has moved on
   * the server. A transcript loaded once goes stale the moment anything writes
   * to it from outside this view: an approval resuming the agent, work
   * dispatched into it, a message arriving over Discord. Keying on updatedAt
   * means one poll upstream keeps every open thread current.
   */
  const stamp = active?.updatedAt ?? 0;
  // What is on screen belongs to a conversation. Keyed only on id and stamp,
  // returning to a chat mid-turn matched the key it was last loaded under and
  // skipped the fetch, leaving another conversation's transcript on screen.
  const [loadedFor, setLoadedFor] = useState<{ id: string; stamp: number } | null>(
    null,
  );
  // A turn ending is worth a reload straight away rather than at the next
  // poll, which is up to five seconds later. The store says so directly: a
  // ref written during render gave the wrong answer under StrictMode, which
  // renders twice and reads the value the first pass had already moved on.
  const justEnded = Boolean(live?.ended);

  // Notes belong to the conversation that produced them.
  useEffect(() => setNotes([]), [activeId]);

  // Work that outlives the turn that started it: a dispatched agent
  // finishing, say. Shown where a command's answer is shown rather than
  // written into the conversation.
  useEffect(
    () =>
      onNote((conversationId, text) => {
        if (conversationId !== activeId) return;
        setNotes((n) => [...n, { id: Date.now(), text }]);
      }),
    [activeId],
  );

  useEffect(() => {
    if (!activeId) return;
    const mine = loadedFor?.id === activeId;
    // Mid-send the optimistic bubble is the only record of what was typed.
    if (mine && sendingIn === activeId) return;
    const holdTranscript = Boolean(mine) && turnRunningHere && !justEnded;
    if (mine && !holdTranscript && loadedFor.stamp === stamp && !justEnded) {
      return;
    }
    if (!mine) {
      // Nothing from the previous conversation stays visible while this one
      // loads.
      setEvents([]);
      setEditing(false);
      setEditingIndex(null);
    }
    let cancelled = false;
    const id = activeId;
    void api
      .conversation(id)
      .then(({ events: got, pending: waiting }) => {
        if (cancelled) return;
        /*
         * Queued messages land first, always.
         *
         * They arrive on the same fetch as the transcript, and holding the
         * transcript still during a turn held these back with it -- so a
         * message queued behind a running turn stayed invisible until the
         * turn ended, which is the one moment it did not matter.
         */
        setPending(waiting);
        /*
         * The transcript itself waits.
         *
         * A conversation is touched more than once per turn, and replacing
         * the whole transcript under a streaming answer is what made a turn
         * look like it was redrawing itself. loadedFor is left alone too, so
         * the fetch happens again once the turn is over.
         */
        if (holdTranscript) return;
        setEvents(got);
        setLoadedFor({ id, stamp });
        // The transcript now holds what the live view was holding, so the
        // handover is done and the steps can go. Doing this on turn-end
        // instead left the screen without either for the length of a fetch.
        settleProgress(id);
      })
      .catch(() => {
        // Emptying the transcript on a failed fetch turned one dropped
        // request into a chat that looks deleted. What is on screen is
        // still the last thing that was true.
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, stamp, sendingIn, loadedFor, justEnded, turnRunningHere]);

  // The live turn grows as it streams, so it is part of what pins the scroll.
  useStickToBottom(boxRef, [events, sendingIn, activeId, live?.steps.length, live?.text]);

  /*
   * Grow the composer with what is typed.
   *
   * There was no growing at all: the field was one row and scrolled inside
   * itself, and its content box was two pixels shorter than its own
   * line-height, so a single line sat slightly clipped and the box appeared
   * to shrink the moment you typed into it. Measured, not guessed: 42.09px
   * empty against 40px with text.
   */
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    // Reset first: scrollHeight cannot shrink below the height already set.
    ta.style.height = "auto";
    const style = window.getComputedStyle(ta);
    const border =
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = parseFloat(style.maxHeight);
    // scrollHeight excludes the border, and the box is border-box, so the
    // border has to be added back or the field is short by exactly that much.
    const wanted = ta.scrollHeight + border;
    const height = Number.isFinite(max) ? Math.min(wanted, max) : wanted;
    ta.style.height = `${height}px`;
    ta.style.overflowY = wanted > height ? "auto" : "hidden";
  }, [draft, activeId]);

  // The orchestrator lives above the list: it is how work gets routed, not one
  // of the threads the routing produces.
  const orchestrator = conversations.find((c) => c.kind === "orchestrator");
  /*
   * Where each messaging surface talks, pinned with the router.
   *
   * One continuous stream per surface, made by the surface rather than by
   * the owner, so it sits above the list with KOS instead of sorting through
   * it by recency. Neither is theirs to rename, archive or delete, and the
   * list offers none of those here.
   */
  const surfaces = useMemo(
    () =>
      conversations
        .filter((c) => c.kind === "surface")
        .sort((a, b) => a.title.localeCompare(b.title)),
    [conversations],
  );
  const tree = useMemo(() => groupChats(conversations), [conversations]);
  const q = query.trim().toLowerCase();
  const matches = (c: Conversation): boolean => !q || c.title.toLowerCase().includes(q);
  const filtered = useMemo(() => tree.roots.filter(matches), [tree, q]);
  /**
   * The projects, one row each, from the manifest. A row opens the project's
   * own page, where its orchestrator and agents are; nothing nests under it
   * here. A project:<slug> thread whose project has left the manifest still
   * gets a row, so it can be reached. Busy when any of its threads is.
   */
  const projectRows = useMemo(() => {
    const threads = new Map<string, Conversation>();
    for (const c of conversations) {
      if (c.kind === "project" && c.projectSlug) threads.set(c.projectSlug, c);
    }
    const busy = (slug: string, thread: Conversation | undefined): boolean =>
      (thread !== undefined && (isBusy(thread) || (progress[thread.id] !== undefined && !progress[thread.id]!.ended))) ||
      (tree.byProject.get(slug) ?? []).some(isBusy);
    const rows = projects
      .filter((p) => p.status !== "archived")
      .map((p) => ({ slug: p.slug, name: p.name, badge: p.type, thread: threads.get(p.slug), busy: busy(p.slug, threads.get(p.slug)) }));
    for (const [slug, c] of threads) {
      if (!rows.some((r) => r.slug === slug)) {
        rows.push({ slug, name: c.title, badge: "project", thread: c, busy: busy(slug, c) });
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [conversations, projects, tree, progress]);
  const shownProjects = q
    ? projectRows.filter((p) => p.name.toLowerCase().includes(q) || (tree.byProject.get(p.slug) ?? []).some(matches))
    : projectRows;
  /** What a project is called, for a crumb: the manifest's name, else its thread's title. */
  const projectName = (slug: string): string =>
    projects.find((p) => p.slug === slug)?.name ?? conversations.find((c) => c.id === `project:${slug}`)?.title ?? slug;

  /*
   * Project mode. The project comes from the manifest, its orchestrator is
   * the project:<slug> thread, and its agents are the chats stamped with its
   * slug. A project built inline has no orchestrator thread until something
   * opens it, so opening the project is what stands it up.
   */
  const projectRecord = project ? projects.find((p) => p.slug === project.slug) : undefined;
  const projectOrchestrator = project
    ? conversations.find((c) => c.id === `project:${project.slug}`)
    : undefined;
  const projectAgents = project ? (tree.byProject.get(project.slug) ?? []) : [];
  const shownAgents = q ? projectAgents.filter(matches) : projectAgents;
  /** An agent thread in this project, opened empty, to be named by what is said in it. */
  const startAgent = async (): Promise<void> => {
    if (!project || creating) return;
    setCreating(true);
    try {
      const made = await api.createProjectAgent(project.slug);
      onChanged();
      onOpen(made.id);
    } catch (err) {
      project.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };
  const needsOrchestrator = Boolean(project && projectRecord && !projectOrchestrator);
  useEffect(() => {
    if (!project || !needsOrchestrator) return;
    void api
      .projectChat(project.slug)
      .then(onChanged)
      .catch((err: unknown) => project.onError(err instanceof Error ? err.message : String(err)));
    // Once per project, and again only if its thread goes missing.
  }, [project?.slug, needsOrchestrator]);
  /** Column widths the owner set by dragging, remembered per browser. */
  const [railW, setRailW] = useState(() => readWidth(RAIL_W));
  const [panelW, setPanelW] = useState(() => readWidth(PANEL_W));
  /** Mid-drag: the columns follow the pointer with no easing in the way. */
  const [resizing, setResizing] = useState(false);
  /** Whether the project's files, pages and tables are shown beside the thread. */
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("kos.project.panel") !== "0";
    } catch {
      return true;
    }
  });
  const togglePanel = (): void => {
    const next = !panelOpen;
    setPanelOpen(next);
    try {
      localStorage.setItem("kos.project.panel", next ? "1" : "0");
    } catch {
      // Remembered for this visit only.
    }
  };

  /*
   * Threads a schedule runs in, kept apart from the ones the owner started.
   *
   * They are conversations like any other and belong in the list, because
   * watching a run and reading last week's happen here. Sorted in with the
   * rest they would crowd it out: a job that runs hourly is the most recent
   * thing in the workspace nearly all the time.
   */
  const scheduled = useMemo(() => {
    const jobs = conversations.filter((c) => c.kind === "schedule");
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  /** Jobs mid-run, so a shut section still says something is happening. */
  const runningJobs = scheduled.filter(
    (c) => (progress[c.id] && !progress[c.id]!.ended) || c.activity === "working",
  ).length;

  /** This chat as a markdown file, saved by the browser. */
  const exportTranscript = (): void => {
    if (!active) return;
    const lines = [`# ${active.title}`, ""];
    for (const e of events) {
      if (e.kind === "message") {
        lines.push(`**${e.role === "you" ? "You" : e.role === "kos" ? "KOS" : "System"}**`, "", e.text, "");
      } else if (e.kind === "tool") {
        lines.push(`> \`${e.name}\` ${e.summary}${e.isError ? " (failed)" : ""}`, "");
      }
    }
    const name = `${active.title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "chat"}.md`;
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    onNotice(`Saved ${name}.`);
  };

  /**
   * Commands the page answers itself. The kernel has no window to open and
   * no file to hand the browser, so these never reach it from here.
   */
  const runLocally = (text: string): boolean => {
    const m = /^\/(btw|aside|export|download|files|workspace)\b\s*([\s\S]*)$/i.exec(text);
    if (!m) return false;
    const verb = m[1]!.toLowerCase();
    const arg = m[2]!.trim();
    if (verb === "btw" || verb === "aside") {
      if (arg) onAside(arg);
      else onNotice("/btw needs a question: /btw what did we decide?");
    } else if (verb === "export" || verb === "download") {
      exportTranscript();
    } else if (project) {
      if (!panelOpen) togglePanel();
      onNotice("The project's files are in the panel on the right.");
    } else if (active?.projectSlug) {
      onOpenProject(active.projectSlug);
    } else {
      window.location.hash = hrefFor({ name: "files" });
    }
    return true;
  };

  async function send(): Promise<void> {
    const text = draft.trim();
    const target = activeId;
    if ((!text && attachments.files.length === 0) || !target) return;
    if (runLocally(text)) {
      setDraft("");
      return;
    }
    // Not blocked while a turn runs. A follow-up is queued on the server and
    // runs next, which is what the owner meant by sending it.
    setSendingIn(target);

    // The message is sent the moment Send is pressed, so it should read that
    // way: the bubble carries its attachments straight away and the composer
    // is empty. Waiting for the turn meant the files sat in the composer,
    // looking unsent, until the answer came back.
    const files = attachments.files;
    // A command is not part of the conversation, so it gets no bubble: one
    // appeared and was taken away again by the reload a moment later.
    const looksLikeCommand = /^\/\S/.test(text) && files.length === 0;
    if (!looksLikeCommand) {
      setEvents((e) => [
        ...e,
        {
          kind: "message",
          role: "you",
          text,
          ...(files.length
            ? {
                attachments: files.map((f) => ({
                  name: f.name,
                  ...(f.mediaType.startsWith("image/")
                    ? { src: `data:${f.mediaType};base64,${f.data}` }
                    : {}),
                })),
              }
            : {}),
        },
      ]);
    }
    setDraft("");
    attachments.clear();

    try {
      const res = await api.message(text, target, files);
      // A command writes nothing to the transcript, so the reload below would
      // drop its reply on the floor. It is kept as a note instead: for /help
      // the reply is the entire output, and for /clear it is the only sign
      // anything happened.
      if (res.isCommand) {
        // Feedback that fits the answer. A line saying what happened (a brief
        // set, a turn stopped) is shown over the page and goes; a list or a
        // report stays in the thread as a note. A move is told over the page
        // too, since a note would be left behind on the thread being left.
        if (res.reply) {
          if (res.switchedTo || !res.reply.includes("\n")) onNotice(res.reply);
          else setNotes((n) => [...n, { id: Date.now(), text: res.reply }]);
        }
        // A command may ask the surface to open something. The kernel has no
        // UI, so it names the panel and the surface obliges.
        if (res.opens === "tools") setEditing(true);
        // A command that moved this surface (/new, /fork, /agent, /switch)
        // moves the page with it; the reply went unheeded before.
        if (res.switchedTo) {
          onChanged();
          onOpen(res.switchedTo);
          return;
        }
      }
      // Reload rather than appending the reply: the turn may have made tool
      // calls, and those belong in the transcript too. A turn suspended on an
      // approval answers here too, and the reload is what puts its approval
      // card on screen.
      const { events: got, pending: waiting } = await api.conversation(target);
      if (target === activeIdRef.current) {
        setEvents(got);
        setPending(waiting);
      }
      // Every path that replaces the transcript is a handover: leaving the
      // finished steps up as well shows each tool call twice until something
      // else happens to clear them.
      settleProgress(target);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEvents((e) => [...e, { kind: "message", role: "kos", text: `Error: ${msg}` }]);
    } finally {
      setSendingIn((id) => (id === target ? null : id));
    }
  }

  /*
   * Managing what is still waiting. All three refuse once the turn has
   * started, because by then the message has been asked and changing it would
   * rewrite the record of a question that was already answered.
   */
  const queuedError = (err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err);
    setNotes((n) => [...n, { id: Date.now(), text: msg }]);
    if (activeIdRef.current) void reloadPending(activeIdRef.current);
  };

  const reloadPending = async (id: string): Promise<void> => {
    try {
      const { pending: waiting } = await api.conversation(id);
      if (id === activeIdRef.current) setPending(waiting);
    } catch {
      // The list is refreshed on the next turn either way.
    }
  };

  const saveQueued = async (id: number): Promise<void> => {
    const draftText = editingQueued?.text.trim();
    if (!draftText || !activeId) return;
    try {
      const { pending: waiting } = await api.editPending(id, draftText, activeId);
      setPending(waiting);
      setEditingQueued(null);
    } catch (err) {
      queuedError(err);
      setEditingQueued(null);
    }
  };

  const dropQueued = async (id: number): Promise<void> => {
    if (!activeId) return;
    try {
      const { pending: waiting } = await api.deletePending(id, activeId);
      setPending(waiting);
    } catch (err) {
      queuedError(err);
    }
  };

  const forkQueued = async (id: number): Promise<void> => {
    try {
      const { conversationId } = await api.forkPending(id);
      if (activeIdRef.current) await reloadPending(activeIdRef.current);
      onChanged();
      onOpen(conversationId);
    } catch (err) {
      queuedError(err);
    }
  };

  /**
   * Approvals for this conversation that no tool call in it is showing.
   *
   * A tool the conversation called carries its pending id on the transcript
   * event and offers the decision there. A build's own requests have no such
   * event, so without this they were reachable only from Home.
   */
  const shownPendingIds = useMemo(
    () =>
      new Set(
        events
          .filter((e) => e.kind === "tool" && e.pendingId)
          .map((e) => (e.kind === "tool" ? e.pendingId : undefined)),
      ),
    [events],
  );
  const loose = useMemo(
    () =>
      approvals.filter(
        (a) =>
          a.conversationId === activeId && !shownPendingIds.has(String(a.id)),
      ),
    [approvals, activeId, shownPendingIds],
  );

  /** Builds this conversation started, running first. */
  const mine = useMemo(
    () =>
      agents
        .filter((b) => b.conversationId === activeId)
        .sort((a, b) => {
          const aLive = a.status === "running" || a.status === "waiting";
          const bLive = b.status === "running" || b.status === "waiting";
          return aLive === bLive ? b.startedAt - a.startedAt : aLive ? -1 : 1;
        })
        .slice(0, 3),
    [agents, activeId],
  );

  /** What a running conversation is doing, for the list. */
  const liveLabel = (l: Live | undefined): string => {
    if (!l) return "working";
    if (l.text) return "replying";
    if (l.congregation?.members.some((m) => m.status === "working")) return "gathering";
    const tool = l.steps.find((s) => s.kind === "tool" && !s.done);
    return tool && tool.kind === "tool" ? tool.tool : "thinking";
  };

  const [stopping, setStopping] = useState(false);

  /**
   * Ask the running turn in this conversation to stop.
   *
   * It said nothing either way: the button looked identical before and
   * after, the answer went on arriving for as long as the model took, and a
   * request the server refused because nothing was running was swallowed
   * whole. Pressing it now says so, and says when there was nothing to stop.
   */
  function stop(): void {
    if (!activeId || stopping) return;
    setStopping(true);
    void api
      .stopConversation(activeId)
      .then((res) => {
        if (!res.stopping) {
          setNotes((n) => [
            ...n,
            { id: Date.now(), text: "Nothing is running in this chat." },
          ]);
        }
      })
      .catch((err: unknown) =>
        setNotes((n) => [
          ...n,
          {
            id: Date.now(),
            text: `Could not stop: ${err instanceof Error ? err.message : String(err)}`,
          },
        ]),
      )
      .finally(() => setStopping(false));
  }


  const rewind = (
    index: number,
    opts: { text?: string; forkTitle?: string } = {},
  ): void => {
    if (!activeId) return;
    const target = activeId;
    setRewinding(true);
    setEditingIndex(null);
    /*
     * A rewind runs a whole turn, so it holds the view the way sending does.
     *
     * Without this the turn was running while the transcript effect was still
     * free to refetch on every stamp: the cut-back thread was replaced by the
     * server's copy mid-turn, so the edited message vanished and came back,
     * and the reply that was streaming underneath was rebuilt from scratch
     * each time -- which is what "it gets removed live" was.
     */
    setSendingIn(target);
    // Cut the thread back now. Waiting for the reply left the old answer on
    // screen while a new one was being written for a question it no longer
    // matched.
    if (opts.forkTitle === undefined) {
      let owner = -1;
      const upTo = events.findIndex((e) => {
        if (e.kind !== "message" || e.role !== "you") return false;
        return ++owner === index;
      });
      if (upTo >= 0) {
        setEvents(
          opts.text === undefined
            ? events.slice(0, upTo + 1)
            : [
                ...events.slice(0, upTo),
                { kind: "message", role: "you", text: opts.text },
              ],
        );
      }
    }
    void api
      .rewind(target, index, opts)
      .then(async (r) => {
        onChanged();
        if (r.conversationId !== target) {
          onOpen(r.conversationId);
          return;
        }
        // The turn is over, so the transcript is the authority again.
        const { events: got, pending: waiting } = await api.conversation(target);
        settleProgress(target);
        if (target !== activeIdRef.current) return;
        setEvents(got);
        setPending(waiting);
      })
      .catch((err: unknown) =>
        setEvents((e) => [
          ...e,
          {
            kind: "message",
            role: "kos",
            text: err instanceof Error ? err.message : String(err),
          },
        ]),
      )
      .finally(() => {
        setRewinding(false);
        setSendingIn((id) => (id === target ? null : id));
      });
  };

  const renderEvent = (e: ChatEvent, i: number, turn: number): ReactElement => {
    if (e.kind === "tool") {
      return (
        <ToolCall
          key={i}
          event={e}
          awaitingApproval={
            e.pendingId !== undefined && pendingApprovals.has(e.pendingId)
          }
          onDecide={onDecide}
        />
      );
    }
    if (e.kind === "reasoning") return <Thinking key={i} text={e.text} />;

    if (editingIndex === turn && turn >= 0) {
      return (
        <MessageEditor
          key={i}
          initial={e.text}
          onCancel={() => setEditingIndex(null)}
          onSubmit={(text) => rewind(turn, { text })}
        />
      );
    }

    return (
      <div key={i} className={`turn turn--${e.role}`}>
        {e.text && (
          <div className={`bubble bubble--${e.role}`}>
            <Markdown text={e.text} />
          </div>
        )}
        {/* Outside the bubble, under it: an attachment is a thing that came
            with the message, not part of the sentence. */}
        {e.attachments && e.attachments.length > 0 && (
          <AttachmentStrip items={e.attachments} />
        )}
        {e.text && e.role !== "system" && (
          <MessageActions
            text={e.text}
            busy={rewinding}
            {...(turn >= 0
              ? {
                  onEdit: () => setEditingIndex(turn),
                  onRetry: () => rewind(turn),
                  onFork: () => rewind(turn, { forkTitle: "" }),
                }
              : {})}
          />
        )}
      </div>
    );
  };

  /** One chat in the list, at the root or under its project. */
  const renderChat = (c: Conversation): ReactElement => (
      <li key={c.id}>
        {/* Hover reveals what can be done with a chat, so the list is
            a list until you need it to be more. */}
        <div className="chats-row">
          <button
            type="button"
            className="chats-more"
            aria-label={`Actions for ${c.title}`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuFor(menuFor === c.id ? null : c.id);
            }}
          >
            <MoreIcon />
          </button>
          {/* Wrapped so it leaves as well as arrives: without this the
              menu appeared gently and then simply stopped existing. */}
          <AnimatePresence>
          {menuFor === c.id && (
            <m.div
              className="chats-menu"
              role="menu"
              ref={menuRef}
              initial={{ opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: -3 }}
              transition={ease}
            >
              <button
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  // Renaming was only reachable by typing /rename, which
                  // is a strange thing to have to know for the one bit
                  // of a chat the owner is most likely to change.
                  setRenaming({ id: c.id, title: c.title });
                }}
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  void api.rewind(c.id, 0, { forkTitle: `${c.title} copy` })
                    .then((r) => {
                      onChanged();
                      onOpen(r.conversationId);
                    })
                    .catch(() => undefined);
                }}
              >
                Duplicate
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuFor(null);
                  void api.archiveConversation(c.id, !showArchived).then(onChanged);
                }}
              >
                {showArchived ? "Unarchive" : "Archive"}
              </button>
              {/* Two presses: delete is the one thing here that cannot be
                  undone, and a menu item that does it on one click is a
                  trap beside Archive. */}
              <button
                type="button"
                className="is-danger"
                onClick={() => {
                  if (confirmDelete !== c.id) {
                    setConfirmDelete(c.id);
                    return;
                  }
                  setMenuFor(null);
                  setConfirmDelete(null);
                  void api.deleteConversation(c.id).then(onChanged);
                }}
              >
                {confirmDelete === c.id ? "Really delete" : "Delete"}
              </button>
            </m.div>
          )}
          </AnimatePresence>
          <a
          className={`chats-item ${c.id === activeId ? "is-active" : ""}`}
          href={hrefOf(c)}
          onClick={(e) => {
            e.preventDefault();
            onOpen(c.id);
          }}
        >
          {c.id === activeId && (
            <m.span className="chats-active-bar" layoutId="chat-active" transition={spring} />
          )}
          <span className="chats-item-top">
            <span className="chats-item-title">{c.title}</span>
            {/* A thread mid-turn or sitting on an approval looked
                exactly like an idle one, and the only way to find out
                was to open it. */}
            {progress[c.id] && !progress[c.id]!.ended ? (
              <span className="chats-flag chats-flag--working">
                {liveLabel(progress[c.id])}
              </span>
            ) : c.activity && c.activity !== "idle" ? (
              <span className={`chats-flag chats-flag--${c.activity}`}>
                {c.activity === "working" ? "working" : "needs you"}
              </span>
            ) : (
              <span className="chats-item-when">{relative(c.updatedAt)}</span>
            )}
          </span>
          {/* Title and state only. The brief and the tool list made every
              row a paragraph; a chat's details are one click away. */}
          </a>
        </div>
      </li>
  );

  return (
    <div
      className={`chats ${collapsed && !narrow ? "is-collapsed" : ""} ${narrow ? "is-narrow" : ""} ${active ? "has-active" : ""} ${listOpen ? "is-list-open" : ""} ${project ? "is-project" : ""} ${project && !panelOpen ? "panel-hidden" : ""} ${resizing ? "is-resizing" : ""}`}
      style={{ "--rail-w": `${railW}px`, "--panel-w": `${panelW}px` } as CSSProperties}
    >
      {narrow && listOpen && (
        <div className="chats-backdrop" aria-hidden="true" onClick={() => setListOpen(false)} />
      )}
      {project ? (
        /* The project's own rail: its orchestrator above, its agents below,
           and nothing from outside it. Back is the way out. */
        <aside className="chats-list chats-list--project">
          <div className="chats-list-head">
            <button type="button" className="chats-back" onClick={project.onBack}>
              <ChevronLeft size={14} />
              All chats
            </button>
            <div className="chats-project-head">
              <span className="chats-project-name">{projectRecord?.name ?? project.slug}</span>
              <span className="chats-project-sub">
                {projectRecord
                  ? projectRecord.description
                    ? `${projectRecord.type} · ${projectRecord.description}`
                    : projectRecord.type
                  : "Not in the manifest"}
              </span>
            </div>
            <input
              className="chats-search"
              value={query}
              placeholder="Search agents…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="chats-pinned">
            {projectOrchestrator ? (
              <a
                className={`chats-root ${projectOrchestrator.id === activeId ? "is-active" : ""}`}
                href={hrefOf(projectOrchestrator)}
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(projectOrchestrator.id);
                }}
              >
                <span className="chats-root-text">
                  <span className="chats-root-title">
                    Orchestrator
                    {progress[projectOrchestrator.id] && !progress[projectOrchestrator.id]!.ended ? (
                      <span className="chats-flag chats-flag--working">
                        {liveLabel(progress[projectOrchestrator.id])}
                      </span>
                    ) : projectOrchestrator.activity && projectOrchestrator.activity !== "idle" ? (
                      <span className={`chats-flag chats-flag--${projectOrchestrator.activity}`}>
                        {projectOrchestrator.activity === "working" ? "working" : "needs you"}
                      </span>
                    ) : null}
                  </span>
                  <span className="chats-root-sub">Plans the work and runs the agents</span>
                </span>
              </a>
            ) : (
              <div className="chats-root is-pending" aria-busy="true">
                <span className="chats-root-text">
                  <span className="chats-root-title">Orchestrator</span>
                  <span className="chats-root-sub">
                    {projectRecord ? "Starting…" : "No such project"}
                  </span>
                </span>
              </div>
            )}
          </div>
          <div className="chats-group-head">
            <span>Agents</span>
            {/* Like New chat: the thread opens empty and the first message
                names it. A form asking for a name, a brief and a task first
                was three fields in the way of saying what you wanted. */}
            <button
              type="button"
              className="chats-group-add"
              aria-label="New agent"
              title="Start an agent: a thread of this project, named by its first message"
              disabled={creating}
              onClick={() => void startAgent()}
            >
              +
            </button>
          </div>
          <ul className="chats-flat">
            {shownAgents.map((c) => renderChat(c))}
            {shownAgents.length === 0 && (
              <li className="chats-empty">
                {q
                  ? "Nothing matches."
                  : "No agents yet. The orchestrator starts them as work comes up, or start one with +."}
              </li>
            )}
          </ul>
        </aside>
      ) : (
        <aside className="chats-list">
          <div className="chats-list-head">
            {/* New chat opens the landing, where you choose a chat, a project,
                or hand it to KOS, rather than dropping into an empty thread. */}
            <button
              type="button"
              className="btn btn--primary chats-new"
              onClick={() => {
                if (narrow) setListOpen(false);
                window.location.hash = hrefFor({ name: "chats" });
              }}
            >
              New chat
            </button>
            <input
              className="chats-search"
              value={query}
              placeholder="Search chats…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {showArchived && <div className="chats-section">Archived chats</div>}
          {!showArchived && (orchestrator || projectRows.length > 0 || surfaces.length > 0) && (
            <div className="chats-pinned">
              {orchestrator && (
                <a
                  className={`chats-root ${orchestrator.id === activeId ? "is-active" : ""}`}
                  href={hrefFor({ name: "chats", id: orchestrator.id })}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(orchestrator.id);
                  }}
                >
                  <span className="chats-root-glyph" aria-hidden="true">✦</span>
                  <span className="chats-root-text">
                    <span className="chats-root-title">
                      {orchestrator.title}
                      <kbd>⌘K</kbd>
                    </span>
                    <span className="chats-root-sub">Routes your work to projects and agents</span>
                  </span>
                </a>
              )}
              <div className="chats-group-head">
                <span>Projects</span>
              </div>
              {projectRows.length === 0 && (
                <p className="chats-group-empty">
                  None yet. Start one from New chat, or just ask KOS and it stands
                  one up when the work needs its own space.
                </p>
              )}
              {projectRows.length > 0 && shownProjects.length === 0 && (
                <p className="chats-group-empty">No project matches.</p>
              )}
              {shownProjects.length > 0 && (
                /* A row is the project. It opens as its own page, with its
                   orchestrator and agents; nothing unfolds here. */
                <ul className="chats-projects">
                  {shownProjects.map((p) => (
                    <li key={p.slug}>
                      <a
                        className={`chats-item chats-item--pinned ${p.thread?.id === activeId ? "is-active" : ""}`}
                        href={hrefFor({ name: "project", slug: p.slug })}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenProject(p.slug);
                        }}
                      >
                        {p.thread?.id === activeId && (
                          <m.span className="chats-active-bar" layoutId="chat-active" transition={spring} />
                        )}
                        <span className="chats-item-top">
                          <span className="chats-item-title">{p.name}</span>
                          {p.busy ? (
                            <span className="chats-flag chats-flag--working">working</span>
                          ) : (
                            <span className="chats-badge">{p.badge}</span>
                          )}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {surfaces.length > 0 && (
                /* One line however many there are. A surface is a way in, not
                   a thread the owner is working in, and given a row each they
                   pushed the chats off the screen. */
                <div className="chats-surfaces">
                  {surfaces.map((c) => (
                    <a
                      key={c.id}
                      className={`chats-surface ${c.id === activeId ? "is-active" : ""}`}
                      href={hrefFor({ name: "chats", id: c.id })}
                      title={`Everything said on ${c.title} arrives here`}
                      onClick={(e) => {
                        e.preventDefault();
                        onOpen(c.id);
                      }}
                    >
                      {(progress[c.id] && !progress[c.id]!.ended) ||
                      c.activity === "working" ? (
                        <span className="chats-surface-dot" aria-hidden="true" />
                      ) : null}
                      {c.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {!showArchived && scheduled.length > 0 && (
            /* Above the chats rather than under them: a job's thread is
               something you go and look at, and at the foot of a long list it
               was a scroll away from everything. Shut by default, because it
               is reference rather than what the owner is doing now. */
            <button
              type="button"
              className={`chats-scheduled ${showScheduled ? "is-open" : ""}`}
              onClick={() => setShowScheduled((v) => !v)}
            >
              <span className="chats-scheduled-mark" aria-hidden="true">
                {showScheduled ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
              Scheduled
              <span className="chats-scheduled-count">
                {runningJobs > 0 ? `${runningJobs} running` : scheduled.length}
              </span>
            </button>
          )}

          {!showArchived && showScheduled && scheduled.length > 0 && (
            /* Under their own heading, not at the foot of the chats. Rendered
               into the list they were below every chat, so opening the section
               meant scrolling past everything to reach what had just been
               opened. */
            <ul className="chats-jobs">
              {scheduled.map((c) => (
                <li key={c.id}>
                  <a
                    className={`chats-item chats-item--job ${
                      c.id === activeId ? "is-active" : ""
                    }`}
                    href={hrefFor({ name: "chats", id: c.id })}
                    onClick={(e) => {
                      e.preventDefault();
                      onOpen(c.id);
                    }}
                  >
                    <span className="chats-item-top">
                      <span className="chats-item-title">{c.title}</span>
                      {progress[c.id] && !progress[c.id]!.ended ? (
                        <span className="chats-flag chats-flag--working">
                          {liveLabel(progress[c.id])}
                        </span>
                      ) : (
                        <span className="chats-item-when">
                          {relative(c.updatedAt)}
                        </span>
                      )}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}

          {!showArchived && (filtered.length > 0 || query.trim() !== "") && (
            <div className="chats-group-head">
              <span>Chats</span>
            </div>
          )}
          <ul className="chats-flat">
            {(showArchived ? archived : filtered).map((c) => renderChat(c))}
            {(showArchived ? archived : filtered).length === 0 && (
              <li className="chats-empty">
                {showArchived
                  ? "Nothing archived."
                  : query.trim()
                    ? "Nothing matches."
                    : "No direct chats. Type below, or let KOS route work to a project."}
              </li>
            )}
          </ul>

          {/* At the foot rather than under the search box: it is a place you go
              occasionally, not a filter on the list you are reading, and it
              took a whole row of the header to say one faint word. */}
          <button
            type="button"
            className={`chats-archived ${showArchived ? "is-on" : ""}`}
            onClick={() => setShowArchived((v) => !v)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {showArchived ? (
                <path d="M15 18l-6-6 6-6" />
              ) : (
                <>
                  <path d="M3 7h18v3H3zM5 10v9h14v-9" />
                  <path d="M10 14h4" />
                </>
              )}
            </svg>
            {showArchived ? "Back to chats" : "Archived"}
          </button>
        </aside>
      )}

      <section className="chats-view">
        {undo && (
          <div className="chats-undo" role="status">
            <span>Archived “{undo.title}”.</span>
            <button
              type="button"
              className="link"
              onClick={() => {
                const back = undo;
                setUndo(null);
                void api.archiveConversation(back.id, false).then(() => {
                  onChanged();
                  onOpen(back.id);
                });
              }}
            >
              Undo
            </button>
          </div>
        )}
        {!active && project ? (
          /* Inside a project there is no landing: the thread is the
             orchestrator's by default, and it is being stood up if it is not
             there yet. */
          <div className="chats-placeholder">
            <p className="ops-muted">
              {!projectRecord
                ? `No project called ${project.slug}.`
                : needsOrchestrator
                  ? "Starting the orchestrator…"
                  : "No such thread in this project."}
            </p>
          </div>
        ) : !active ? (
          <div className="chats-placeholder">
            {/* Opening KOS lands here. It used to say "pick a chat"; a front
                door should offer the way in. */}
            <m.div
              className="chats-welcome"
              variants={stagger}
              initial="hidden"
              animate="show"
            >
              <m.span className="chats-welcome-glyph" aria-hidden="true" variants={card}>
                ✦
              </m.span>
              <m.div className="chats-welcome-head" variants={card}>
                <p className="chats-welcome-title">What do you want done?</p>
                <p className="chats-welcome-sub">
                  KOS routes it to the right project or agent, or stands a new one up.
                </p>
              </m.div>
              {/* The question has to be answerable here. A button that leads
                  to an empty chat is a detour; typing is the way in. */}
              <m.form
                className="chats-welcome-form"
                variants={card}
                onSubmit={(e) => {
                  e.preventDefault();
                  void startFromLanding();
                }}
              >
                <div className="chats-welcome-field">
                  <textarea
                    className="hl-area chats-welcome-input"
                    rows={2}
                    autoFocus
                    value={opening}
                    placeholder={
                      mode === "project"
                        ? "Describe the project to build…"
                        : mode === "chat"
                          ? "Start a chat…"
                          : "Ask, or tell KOS what to build…"
                    }
                    onChange={(e) => setOpening(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div className="chats-welcome-actions">
                    <div
                      className="chats-mode"
                      role="radiogroup"
                      aria-label="What to create"
                    >
                      {(
                        [
                          ["kos", "Ask KOS"],
                          ["chat", "Chat"],
                          ["project", "Project"],
                        ] as const
                      ).map(([m, label]) => (
                        <button
                          key={m}
                          type="button"
                          role="radio"
                          aria-checked={mode === m}
                          className={`chats-mode-opt ${mode === m ? "is-active" : ""}`}
                          onClick={() => setMode(m)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={creating || !opening.trim()}
                    >
                      {creating
                        ? "Opening…"
                        : mode === "project"
                          ? "Create"
                          : mode === "chat"
                            ? "Start"
                            : "Ask KOS"}
                    </button>
                  </div>
                </div>
              </m.form>
              {tree.roots.length > 0 && (
                <m.div className="chats-welcome-recent" variants={card}>
                  <span className="chats-welcome-recent-label">Recent</span>
                  <ul>
                    {tree.roots.slice(0, 5).map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="chats-welcome-chip"
                          onClick={() => onOpen(c.id)}
                        >
                          {c.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </m.div>
              )}
            </m.div>
          </div>
        ) : (
          <>
            <header className="chats-view-head">
              <div className="chats-view-title">
                {/* The list toggle and the lineage share a row above the
                    title: the toggle is the same panel glyph as the
                    workspace's, mirrored, and the title line keeps only the
                    title. A chevron in it, next to the crumbs' own, read as
                    two kinds of arrow for two different things. */}
                <div className="chats-view-path">
                  <button
                    type="button"
                    className={`icon-btn chats-toggle ${collapsed && !narrow ? "" : "is-on"}`}
                    aria-label={narrow ? "Show chats" : collapsed ? "Show the chat list" : "Hide the chat list"}
                    aria-pressed={!(collapsed && !narrow)}
                    title={narrow ? "Show chats" : collapsed ? "Show the chat list" : "Hide the chat list"}
                    onClick={() => (narrow ? setListOpen(true) : setCollapsed((v) => !v))}
                  >
                    <PanelIcon side="left" />
                  </button>
                  {(() => {
                    const crumbs: { label: string; id: string }[] = [];
                    if (orchestrator && active.id !== orchestrator.id) crumbs.push({ label: "KOS", id: orchestrator.id });
                    if (active.projectSlug && active.kind !== "project") {
                      crumbs.push({
                        label: projectName(active.projectSlug),
                        id: `project:${active.projectSlug}`,
                      });
                    }
                    return crumbs.length > 0 ? (
                      <nav className="chats-crumbs" aria-label="Where this chat sits">
                        {crumbs.map((c) => (
                          <button key={c.id} type="button" className="link" onClick={() => onOpen(c.id)}>
                            {c.label}
                          </button>
                        ))}
                      </nav>
                    ) : null;
                  })()}
                </div>
                <h1>
                  {active.title}
                  {active.kind === "project" && <span className="chats-role">orchestrator</span>}
                </h1>
                {/* Inside the project the rail lists the agents, so the count
                    would say what is already in view. */}
                {active.kind === "project" && !project && (
                  <p className="chats-lineage">
                    {projectSummary(tree.byProject.get(active.projectSlug ?? "") ?? [])}
                  </p>
                )}
                {active.brief && <p className="chats-brief">{active.brief}</p>}
                {/* Counts are not something anyone came here to read. Only
                    the tool scope is said, and only when it is not the
                    default, because that is a capability the chat lacks. */}
                <div className="chats-meta">
                  {active.toolAllow !== null && (
                    <span>
                      {active.toolAllow.length === 0
                        ? "no tools"
                        : `scoped to ${active.toolAllow.join(", ")}`}
                    </span>
                  )}
                </div>
              </div>
              <div className="chats-view-actions">
                {project && (
                  /* An icon, not words: beside Configure and Archive a third
                     label squeezed the title into two lines. */
                  <button
                    type="button"
                    className={`icon-btn chats-panel-toggle ${panelOpen ? "is-on" : ""}`}
                    aria-pressed={panelOpen}
                    aria-label={panelOpen ? "Hide the workspace panel" : "Show the workspace panel"}
                    title={panelOpen ? "Hide files, pages and tables" : "Show files, pages and tables"}
                    onClick={togglePanel}
                  >
                    <PanelIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setEditing((v) => !v)}
                >
                  {editing ? "Close" : "Configure"}
                </button>
                {active.kind !== "orchestrator" && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      const was = { id: active.id, title: active.title };
                      void api.archiveConversation(active.id).then(() => {
                        onChanged();
                        setUndo(was);
                        window.location.hash = "#/";
                      });
                    }}
                  >
                    Archive
                  </button>
                )}
              </div>
            </header>

            <Modal
              open={editing}
              title={`Configure “${active.title}”`}
              onClose={() => setEditing(false)}
            >
              <ChatConfig
                key={active.id}
                conversation={active}
                onSaved={onChanged}
                onClose={() => setEditing(false)}
              />
            </Modal>

            {/* Renaming is the one thing about a chat an owner changes most,
                and it was reachable only by knowing to type /rename. */}
            <Modal
              open={renaming !== null}
              title="Rename chat"
              onClose={() => setRenaming(null)}
            >
              <form
                className="rename-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = renaming?.title.trim();
                  if (!renaming || !next) return;
                  void api
                    .renameConversation(renaming.id, next)
                    .then(() => {
                      setRenaming(null);
                      onChanged();
                    })
                    .catch(() => setRenaming(null));
                }}
              >
                <input
                  className="kos-input"
                  autoFocus
                  value={renaming?.title ?? ""}
                  onChange={(e) =>
                    setRenaming((r) => (r ? { ...r, title: e.target.value } : r))
                  }
                />
                <div className="rename-actions">
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={!renaming?.title.trim()}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setRenaming(null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </Modal>

            {/* The thread knows the chats and agents by name, so a chip can
                read "Lane A" rather than the id it is addressed by. */}
            <MentionNames resolve={nameFor}>
            <div className="chats-thread" ref={boxRef}>
              {visible.length === 0 && <p className="hint">Nothing said yet.</p>}
              {(() => {
                // Owner turns are numbered in order, because rewind addresses
                // them by position rather than by any id a transcript keeps.
                let owner = -1;
                return visible.map((e, i) => {
                  const turn = e.kind === "message" && e.role === "you" ? ++owner : -1;
                  return renderEvent(e, i, turn);
                });
              })()}
              {live ? (
                <LiveTurn live={live} />
              ) : (
                sendingIn === activeId && (
                  // The same markup a running turn uses, not a lookalike:
                  // built separately it picked up the bubble's font size and
                  // colour and read as a different kind of thing.
                  <div className="bubble bubble--kos live">
                    <div className="live-head">
                      <span className="live-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="live-what">Sending</span>
                    </div>
                  </div>
                )
              )}

              {/* A build this conversation started. It runs somewhere else and
                  for minutes, so the chat says it exists and links to it
                  rather than going quiet and leaving the reader to find the
                  Agents page on their own. */}
              {mine.map((b) => (
                <button
                  type="button"
                  className={`chat-agent chat-agent--${b.status}`}
                  key={b.id}
                  onClick={() => onOpenAgent(b.id)}
                >
                  <span className={`agent-dot agent-dot--${b.status}`} />
                  <span className="chat-agent-main">
                    <span className="chat-agent-dir">{b.dir}</span>
                    <span className="chat-agent-latest">{b.latest}</span>
                  </span>
                  <span className="chat-agent-go">Open log →</span>
                </button>
              ))}

              {/* Waiting on a decision, and not attached to any tool call in
                  this transcript. A build's requests arrive this way: the
                  chat showed "I'll continue once the result comes through"
                  and then nothing, because the thing waiting on the owner was
                  invisible from here. */}
              <AnimatePresence initial={false}>
              {loose.map((a) => (
                <m.div
                  className="loose-approval"
                  key={a.id}
                  layout
                  initial={{ opacity: 0, scale: 0.98, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
                  transition={spring}
                >
                  <div className="loose-approval-main">
                    {/* What it is about to do, first: "risky tool" was the
                        whole card, and the command it wanted to run was
                        nowhere. The reason is a tag, the arguments a fold. */}
                    <code>{a.tool}</code>
                    <span className="loose-approval-what">{summarizeAction(a.tool, a.args)}</span>
                    {a.reason && <span className="loose-approval-why">{a.reason}</span>}
                    <details className="loose-approval-details">
                      <summary>Arguments</summary>
                      <pre>{prettyArgs(a.args)}</pre>
                    </details>
                  </div>
                  <div className="loose-approval-actions">
                    <Decision
                      id={a.id}
                      deciding={deciding}
                      onDecide={(id, ok, remember) => onDecide(String(id), ok, remember)}
                    />
                  </div>
                </m.div>
              ))}
              </AnimatePresence>

              {notes.map((n) => (
                <m.div
                  className="chats-note"
                  key={n.id}
                  variants={listItem}
                  initial="hidden"
                  animate="show"
                >
                  {/* A command's answer is a reply to something you did, not
                      part of the conversation, and it sat there until the
                      chat was reloaded. */}
                  <button
                    type="button"
                    className="icon-btn note-close"
                    title="Dismiss"
                    onClick={() =>
                      setNotes((all) => all.filter((x) => x.id !== n.id))
                    }
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                  <Markdown text={n.text} />
                  {/* Also at the end: a long answer meant scrolling back to
                      the top to reach the corner. */}
                  <button
                    type="button"
                    className="btn btn--sm note-done"
                    onClick={() =>
                      setNotes((all) => all.filter((x) => x.id !== n.id))
                    }
                  >
                    Dismiss
                  </button>
                </m.div>
              ))}

              {/* Sent, taken, and waiting for the turn ahead of it. Shown
                  after the running turn because that is the order they will
                  be answered in. */}
              {/* Nothing queued runs until the turn ahead of it finishes, and
                  the only lever on that is stopping the turn. Offered once,
                  above the queue, rather than on every message: it acts on
                  the running turn, not on any one of them. */}
              {pending.length > 0 && running && (
                <div className="queued-head">
                  <span>
                    {pending.length} waiting on the turn in progress
                  </span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    title="Stop what KOS is doing now so the next message starts"
                    onClick={() => stop()}
                  >
                    Interrupt and send next
                  </button>
                </div>
              )}

              <AnimatePresence initial={false}>
              {pending.map((p) => (
                <m.div
                  className="queued"
                  key={p.id}
                  layout
                  variants={listItem}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                  transition={ease}
                >
                  {editingQueued?.id === p.id ? (
                    <div className="queued-edit">
                      <textarea
                        className="kos-input"
                        rows={3}
                        value={editingQueued.text}
                        autoFocus
                        onChange={(e) =>
                          setEditingQueued({ id: p.id, text: e.target.value })
                        }
                      />
                      <div className="queued-actions">
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => void saveQueued(p.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setEditingQueued(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="bubble bubble--you is-queued">
                        {p.text}
                        <span className="queued-mark">queued</span>
                      </div>
                      <div className="queued-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="Edit before it runs"
                          onClick={() => setEditingQueued({ id: p.id, text: p.text })}
                        >
                          <EditIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Copy"
                          onClick={() => void navigator.clipboard.writeText(p.text)}
                        >
                          <CopyIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Ask this in a copy of the chat instead"
                          onClick={() => void forkQueued(p.id)}
                        >
                          <ForkIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--danger"
                          title="Drop it before it runs"
                          onClick={() => void dropQueued(p.id)}
                        >
                          {/* Drawn like the others. A text cross sat on a
                              different baseline and at a different weight
                              from the icons beside it. */}
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            aria-hidden="true"
                          >
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}
                </m.div>
              ))}
              </AnimatePresence>
            </div>
            </MentionNames>

            <div
              className={`chats-composer composer ${drop.over ? "is-over" : ""}`}
              {...drop.handlers}
            >
              <AttachmentStrip
                items={attachments.files.map((f) => ({
                  name: f.name,
                  ...(f.mediaType.startsWith("image/")
                    ? { src: `data:${f.mediaType};base64,${f.data}` }
                    : {}),
                }))}
                onRemove={attachments.remove}
              />
              <div className="composer-input">
                <AutocompleteMenu
                  suggestions={suggestions}
                  cursor={acCursor}
                  onPick={choose}
                />
                <HighlightedInput value={draft} textareaRef={inputRef}>
                <textarea
                  className="hl-area"
                  ref={inputRef}
                  rows={1}
                  value={draft}
                  placeholder={`Message ${active.title.length > 32 ? "KOS" : active.title}…  @ to reference, / for commands`}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    syncTrigger();
                  }}
                  onClick={syncTrigger}
                  onBlur={() => setTrigger(null)}
                  onKeyUp={(e) => {
                    // Arrows move the caret, so the trigger is re-read after
                    // them too, but not while the menu owns them.
                    if (suggestions.length === 0) syncTrigger();
                    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      syncTrigger();
                    }
                  }}
                  onKeyDown={(e) => {
                    if (suggestions.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setAcCursor((c) => (c + 1) % suggestions.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setAcCursor(
                          (c) => (c - 1 + suggestions.length) % suggestions.length,
                        );
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        const picked = suggestions[acCursor];
                        if (picked) {
                          e.preventDefault();
                          choose(picked);
                          return;
                        }
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setTrigger(null);
                        return;
                      }
                    }
                    // Cmd or Ctrl with Enter stops the turn. Enter alone
                    // sends, so the interrupt needs a modifier or every
                    // message would be a stop.
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      if (running) stop();
                      return;
                    }
                    composerKeyDown(e, () => void send());
                  }}
                />
                </HighlightedInput>
              </div>
              <div className="sheet-composer-bar">
                <AttachButton onAdd={(l) => void attachments.add(l)} />
                <VoiceInput
                  onText={(said) =>
                    // Appended rather than replacing: dictation is usually one
                    // sentence at a time, and typing around it should work.
                    setDraft((d) => (d ? `${d.replace(/\s+$/, "")} ${said}` : said))
                  }
                />
                <ModelPicker />
                {/* The hint took the widest slot in the row to say something
                    every chat surface already does. The space is the model's. */}
                {/* Beside Send rather than under the title: how full the chat
                    is matters when you are about to add to it, which is here.
                    Keyed off sendingIn so it re-reads once a turn lands. */}
                <ContextMeter
                  conversationId={active.id}
                  refreshKey={sendingIn === null ? 1 : 0}
                />
                <span className="composer-spacer" />
                {running ? (
                  <button
                    type="button"
                    className="btn btn--stop"
                    disabled={stopping}
                    onClick={stop}
                  >
                    {stopping ? "Stopping…" : "Stop"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void send()}
                    disabled={draft.trim() === "" && attachments.files.length === 0}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {project && (
        /* Mounted while hidden, so hiding is the column sliding shut rather
           than the panel vanishing; it polls nothing until it is back. */
        <ProjectPanel
          slug={project.slug}
          onOpenPage={project.onOpenPage}
          onOpenFile={project.onOpenFile}
          onChanged={onChanged}
          onError={project.onError}
          hidden={!panelOpen}
        />
      )}

      {/* The columns are the owner's to size. The handles sit in the gaps. */}
      {!narrow && (
        <Gutter
          className="chats-gutter--rail"
          label="the chat list"
          value={railW}
          min={RAIL_W.min}
          max={RAIL_W.max}
          fallback={RAIL_W.fallback}
          grows="right"
          onChange={(w) => {
            setResizing(true);
            setRailW(w);
          }}
          onDone={(w) => {
            setResizing(false);
            saveWidth(RAIL_W, w);
          }}
          // Pushed past its narrowest: shut; dragged back out: open again.
          collapsed={collapsed}
          onCollapse={() => setCollapsed(true)}
          onExpand={() => setCollapsed(false)}
        />
      )}
      {project && !narrow && (
        <Gutter
          className="chats-gutter--panel"
          label="the workspace panel"
          value={panelW}
          min={PANEL_W.min}
          max={PANEL_W.max}
          fallback={PANEL_W.fallback}
          grows="left"
          onChange={(w) => {
            setResizing(true);
            setPanelW(w);
          }}
          onDone={(w) => {
            setResizing(false);
            saveWidth(PANEL_W, w);
          }}
          collapsed={!panelOpen}
          onCollapse={() => {
            if (panelOpen) togglePanel();
          }}
          onExpand={() => {
            if (!panelOpen) togglePanel();
          }}
        />
      )}
    </div>
  );
}

/** A draggable column: where its width is kept, its bounds, and where it starts. */
interface ColumnSpec {
  key: string;
  min: number;
  max: number;
  fallback: number;
}
const RAIL_W: ColumnSpec = { key: "kos.chats.rail", min: 150, max: 420, fallback: 240 };
const PANEL_W: ColumnSpec = { key: "kos.project.panel.w", min: 200, max: 640, fallback: 300 };

function readWidth(spec: ColumnSpec): number {
  try {
    const n = Number(localStorage.getItem(spec.key));
    return n >= spec.min && n <= spec.max ? n : spec.fallback;
  } catch {
    return spec.fallback;
  }
}

function saveWidth(spec: ColumnSpec, width: number): void {
  try {
    localStorage.setItem(spec.key, String(width));
  } catch {
    // Remembered for this visit only.
  }
}

/** True below the width at which the two panes stop fitting side by side. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof matchMedia === "function" ? matchMedia("(max-width: 860px)").matches : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(max-width: 860px)");
    const sync = (): void => setNarrow(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}
