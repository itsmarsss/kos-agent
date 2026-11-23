import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import { AnimatePresence, m } from "motion/react";
import { kindWord, runningTail, timeWords, STATE_WORDS, stepMechanics, summarizeAction, timeMarks } from "@kos/shared";
import { announce, Menu, ModeChip, NotFound, rise } from "@kos/kit";
import { ArchiveIcon, type BlockActions, Chips, Field, MessageTime, SearchField, SheetFoot, When, Timed, TimeLine, card, ChevronLeft, CloseIcon, ComposeIcon, CopyIcon, Count, ease, EditIcon, EmptyState, Face, faceLookOf, ForkIcon, GearIcon, HashIcon, IconButton, KOS_SEED, listItem, Markdown, MentionNames, moodOf, MoreIcon, PanelIcon, RefChip, SendIcon, spring, stagger, StatusDot, StopIcon, useDismiss, useKosLook, useOverlayScroll, WorkingDots, WrenchIcon } from "@kos/kit";

import { PictureGallery } from "./Lightbox.js";
import { PendingAsk } from "./PendingAsk.js";
import { SecretOffer } from "./SecretOffer.js";
import { VoiceInput } from "./VoiceInput.js";

import { ContextMeter } from "./ContextMeter.js";
import { byAttention, groupChats, isBusy, placeOf, projectSummary } from "./chattree.js";
import { AgentPanel } from "./AgentPanel.js";
import { ConfirmButton } from "./kit.js";
import { Gutter } from "./Gutter.js";
import { NewProjectDialog } from "./NewProjectDialog.js";
import { railRowKeys, railSearchKeys } from "./railkeys.js";
import { ProjectMark } from "./ProjectMark.js";
import { ProjectPanel } from "./ProjectPanel.js";
import { ArtifactRail, ArtifactStrip, type RailOwner, useArtifactTitles, useOwnedArtifacts } from "./ArtifactRail.js";
import { ArtifactViewer, rootChatId, type ViewerHandle } from "./ArtifactsPage.js";
import { chatIdOf } from "./artifactowner.js";
import { PANEL_ROOM, usePanelDrawer, useRoomFor } from "./paneldrawer.js";
import { ArtifactOpen, type ArtifactOpeners } from "./ArtifactStep.js";
import { RailGroup, useRailFolds } from "./RailGroup.js";
import {
  api,
  type CronJob,
  type Attachment,
  type ChatEvent,
  type Conversation,
  type PageSummary,
  type BrowserTabInfo,
  type BuildRecord,
  type PendingAction,
  type PendingMessage,
  type Project,
  type DiscordChannel,
} from "./api.js";
import { answeredAside, queuedAnyway, retireAsides, waitingAsides, waitingRows, type Aside } from "./asides.js";
import { tabName } from "./address.js";
import { AttachButton, useAttachments, useDropZone } from "./Attachments.js";
import { AttachmentStrip } from "./AttachmentStrip.js";
import { OriginLine, surfaceName } from "./OriginLine.js";
import { ModelPicker } from "./ModelPicker.js";
import { useChatMode } from "./chatmode.js";
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
import { MessageEditor } from "./MessageActions.js";
import { MessageTurn, type TurnAction } from "./MessageTurn.js";
import { UnsentNote } from "./UnsentNote.js";
import { toast, Toast } from "./Toast.js";
import { EarlierButton, JumpToLatest, useAwayFromLatest } from "./ThreadEnds.js";
import { useReach } from "./reach.js";
import { useStable } from "./stable.js";

import {
  clearProgress,
  settleProgress,
  seedProgress,
  useProgress,
  onNote,
  onTurnEnd,
  onRenamed,
  type Live,
} from "./progress.js";
import { LiveTurn } from "./LiveTurn.js";
import { ActivityDot, buildDot, QueuedMark } from "./StatusDot.js";
import { ToolCall } from "./ToolCall.js";
import { ChatConfig } from "./ChatConfig.js";
import { Modal } from "./Modal.js";
import { HandoffForm } from "./HandoffForm.js";
import { useFound } from "./found.js";
import { hrefFor } from "./routes.js";
import { useHashParam } from "./hashparams.js";
import { fileMention } from "./finder/model.js";
import { backInComposer, composerKeyDown, unsentHome, useAutoGrow, useStickToBottom } from "./composer.js";
import { scheduleWords } from "./schedule.js";
import { jobTitle } from "./schedulewords.js";

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

/** The page scoped to one blob. See ChatsPageProps.agent. */
export interface AgentMode {
  name: string;
  /** Out of the agent, back to the list. */
  onBack: () => void;
  /** An older widget page from its list, which opens on its own page. */
  onOpenPage: (id: string) => void;
  onOpenFile: (path: string) => void;
  onError: (message: string) => void;
  /** The agent was removed from its panel: nothing is left to show here. */
  onRemoved: () => void;
}

export interface ChatsPageProps {
  conversations: Conversation[];
  /** Manifest projects, so the rail shows a project even before it has an orchestrator conversation. */
  projects: Project[];
  activeId?: string;
  /** The chats have not been read yet: a chat's address shows where its thread will be, not the landing. */
  loading?: boolean;
  /** The landing was asked for (New chat): on a phone it takes the list's place, as an open chat does. */
  composing?: boolean;
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
  /** The browser's tabs, so a chip can name one by its page rather than its id. */
  tabs?: BrowserTabInfo[];
  /** Every job, so a project's rail can show its own. */
  crons: CronJob[];
  /** Open the editor on a job, or on a new one for a project. */
  onEditCron: (job?: CronJob, projectSlug?: string) => void;
  onOpen: (id: string) => void;
  /** A project row opens the project's workspace; its chat is one action from there. */
  onOpenProject: (slug: string) => void;
  /** An empty project from the rail's +, the same dialog the Projects page has. */
  onCreateProject?: (input: { name: string; type: string }) => Promise<void>;
  /** Delete a project from its row's menu; two presses, like deleting a chat. */
  onDeleteProject?: (slug: string) => Promise<void>;
  /**
   * Project mode: the page is scoped to one project. The rail lists its
   * orchestrator and agents (nothing else), the view is whichever of those
   * is open, and a third column holds the project's files, pages and tables.
   */
  project?: ProjectMode;
  /**
   * Agent mode: the page is one blob's. The rail is its thread
   * and the chats it has in projects, the view is its thread, and the third
   * column holds its file and schedule. Its thread stays off the Chats tab.
   */
  agent?: AgentMode;
  /** `/btw <question>`: ask it beside this chat, in the quick-question window. */
  onAside: (question: string) => void;
  /** A line of feedback shown briefly over the page: what a command just did. */
  onNotice: (text: string) => void;
  onChanged: () => void;
  onDecide: (pendingId: string, approved: boolean, remember?: boolean, code?: string) => void;
  /**
   * A message handed to the server rather than typed here, shown until the
   * transcript has it. Without it a fix attempt opened on an agent thinking
   * about nothing, and the question it was answering appeared a minute later.
   */
  seed?: { id: string; text: string };
  /** Words to put in the composer once, as asking about a file from Files does; stamped so the same words can be asked again. */
  compose?: { text: string; n: number };
  /** The composer took them. */
  onComposed?: () => void;
}


/** A title cut to a length, with an ellipsis: the composer's placeholder names the chat however long it is. */
/** A message that did not reach KOS, as Retry sends it again. */
interface Unsent {
  text: string;
  files: Attachment[];
}

function clipped(title: string, max: number): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

/** What a running conversation is doing, for the list. */
function liveLabel(l: Live | undefined): string {
  if (!l) return "working";
  if (l.text) return "replying";
  if (l.congregation?.members.some((m) => m.status === "working")) return "gathering";
  const tool = l.steps.find((s) => s.kind === "tool" && !s.done);
  return tool && tool.kind === "tool" ? tool.tool : "thinking";
}

/**
 * A thread's state as a dot.
 *
 * An approval waiting on the owner comes first: a turn paused on one is
 * not ended, so the live view still says working, and the dot stayed blue
 * over the one thing that needed a hand. Then what the live view knows,
 * because it is ahead of the list's poll; then what the server said.
 */
/**
 * A chat row as a screen reader hears it: the title first, then its state
 * once, then when ("Fetch the status page, needs you, 1m ago"). The dot's
 * own label led and the text said the state again; "read" said nothing.
 */
export function chatRowWords(title: string, chat: Pick<Conversation, "activity" | "unread" | "updatedAt">, opts: { waiting?: boolean; working?: boolean; queued?: number } = {}): string {
  const state =
    opts.waiting || chat.activity === "needs-you" ? "needs you" : opts.working || chat.activity === "working" ? "working" : chat.activity === "error" ? "failed" : chat.unread ? "unread" : null;
  const queued = opts.queued ? `${opts.queued} queued` : null;
  return [title, state, queued, timeWords(chat.updatedAt)].filter(Boolean).join(", ");
}

function ThreadDot({
  live,
  chat,
  waiting,
}: {
  live: Live | undefined;
  chat: Pick<Conversation, "activity" | "lastError" | "unread">;
  /** An approval in this thread is waiting on the owner. */
  waiting?: boolean;
}): ReactElement | null {
  if (waiting || chat.activity === "needs-you") return <StatusDot state="needs-you" label="needs you" />;
  if (live && !live.ended) return <StatusDot state="working" label={liveLabel(live)} />;
  return <ActivityDot activity={chat.activity} error={chat.lastError} unread={chat.unread} />;
}

/** What the landing's Send does with what was typed. */
export type LandingMode = "kos" | "chat" | "project";

/** The rail's New chat starts a chat of the owner's own; Chats opened bare is KOS's front door. */
export function landingMode(composing: boolean): LandingMode {
  return composing ? "chat" : "kos";
}

/** The landing's heading for each choice, so it never promises KOS's routing for a chat of the owner's own. */
export const LANDING_WORDS: Readonly<Record<LandingMode, { title: string; sub: string }>> = {
  kos: { title: "What do you want done?", sub: "KOS finds the chat, project or blob it belongs in, or starts one." },
  chat: { title: "Start a new chat", sub: "A chat of its own, empty until you write. KOS answers here." },
  project: { title: "Start a project", sub: "Describe it, and KOS makes the project and its chat." },
};

/** What KOS's own chat is for, in place of the prompt it runs on. */
export const KOS_CHAT_LINE = "Tell KOS what you want done. It finds the chat, project or blob the work belongs in, or starts one.";

/**
 * The one line under a chat's title. KOS's chat, a project's orchestrator
 * and Maintenance carry KOS's own prompt as their brief, written for the
 * model: KOS's line says what it is for, a project's is the project's
 * description, or none. Any other chat's brief is the owner's own, set in
 * Configure.
 */
export function chatLine(chat: Pick<Conversation, "kind" | "brief" | "projectSlug">, projects: readonly Pick<Project, "slug" | "description">[]): string | null {
  if (chat.kind === "orchestrator") return KOS_CHAT_LINE;
  if (chat.kind === "project") return projects.find((p) => p.slug === chat.projectSlug)?.description ?? null;
  return chat.brief ?? null;
}

export function ChatsPage({
  conversations,
  projects,
  activeId,
  loading = false,
  composing = false,
  pendingApprovals,
  approvals,
  deciding,
  agents,
  onOpenAgent,
  tabs = [],
  crons,
  onEditCron,
  onOpen,
  onOpenProject,
  onCreateProject,
  onDeleteProject,
  project,
  agent,
  onAside,
  onNotice,
  onChanged,
  onDecide,
  seed,
  compose,
  onComposed,
}: ChatsPageProps): ReactElement {
  const [query, setQuery] = useState("");
  /** KOS's face, wherever KOS is drawn on this page. */
  const kos = useKosLook();
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
  // KOS not answering this tab: sending waits, and says so, until it is back.
  const reach = useReach();
  // The files of each message that did not reach KOS, by its bubble, for its Retry and Edit.
  const unsentFiles = useRef(new Map<ChatEvent, Attachment[]>());
  /** References put in the composer after what is typed, and the composer focused for the question. */
  const addToDraft = (words: string): void => {
    setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, "")} ${words} ` : `${words} `));
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  useEffect(() => {
    if (!compose) return;
    addToDraft(compose.text);
    onComposed?.();
    // The stamp is what makes this fire: the same words asked twice are put in twice.
  }, [compose?.n]);
  /** Files asked about from the panel beside the chat: referenced in its composer. */
  const askAboutFiles = (paths: string[]): void => {
    drawer.close();
    addToDraft(paths.map(fileMention).join(" "));
  };
  // The tools a typed block's Send may name; none known, it offers no Send.
  const [toolNames, setToolNames] = useState<string[]>([]);
  useEffect(() => {
    void api.tools().then((tools) => setToolNames(tools.map((t) => t.name)), () => setToolNames([]));
  }, []);
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
  /**
   * Sent while a turn was running here, until the server answers for it. The
   * turn takes it in at its next step, or it runs after; either way it waits
   * under the running turn, never above the steps and words already shown.
   */
  const [asides, setAsides] = useState<Aside[]>([]);
  const asideKeys = useRef(0);
  /** A chat's waiting rows as fetched: each new row is an aside sent here, which it then stands for. */
  const showPending = (id: string, rows: PendingMessage[]): void => {
    if (id === activeIdRef.current) setPending(rows);
    setAsides((a) => retireAsides(a, id, rows));
  };
  /** The queued message being rewritten, if any. */
  const [editingQueued, setEditingQueued] = useState<{ id: number; text: string } | null>(
    null,
  );
  const attachments = useAttachments();
  const progress = useProgress();
  /** Threads with an approval waiting, from the same list the inbox shows. */
  const waitingOn = useMemo(
    () => new Set(approvals.map((a) => a.conversationId).filter((id): id is string => typeof id === "string")),
    [approvals],
  );
  // A reply landing anywhere refreshes the list at once, so the unread dot
  // appears when the reply does rather than on the next poll.
  useEffect(() => onTurnEnd(() => onChanged()), [onChanged]);
  // And a chat's new name the moment it lands, in the list and the header.
  useEffect(() => onRenamed(() => onChanged()), [onChanged]);

  // The list is the authority on what is running: a turn that started before
  // this view opened produced no events it could have seen, and one that
  // finished while the connection was down would otherwise stay on screen.
  // Not, though, for a turn the stream has just announced: the list in hand
  // was fetched before it began and still says idle, and clearing on that
  // word wiped every turn started from Discord or another tab the moment it
  // started, leaving the next poll to seed it back as a resumed fragment
  // with no words and no streamed text. A fresh entry is given time for the
  // list to catch up.
  useEffect(() => {
    seedProgress(
      conversations.filter((c) => c.activity === "working").map((c) => c.id),
    );
    for (const c of conversations) {
      const live = progress[c.id];
      if (!live || c.activity === "working") continue;
      const stale = live.resumed || Date.now() - live.since > FRESH_TURN_MS;
      // Nothing left to hand over, or nobody here to hand it to: a turn that
      // ended in a conversation the reader is not looking at has no transcript
      // to be swapped into.
      if ((stale && live.steps.length === 0) || (live.ended && c.id !== activeId)) {
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
  useDismiss(listOpen, () => setListOpen(false), { away: false, scroll: false, resize: false, escape: "dialog" });
  const [showArchived, setShowArchived] = useState(false);
  /** A chat just archived from its header, offered back for a moment. */
  /** The chat just archived, for its toast's Undo; `reopen` when it was open, so Undo brings the owner back to it. */
  const [undo, setUndo] = useState<{ id: string; title: string; reopen?: boolean } | null>(null);
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
  const [mode, setMode] = useState<LandingMode>(landingMode(composing));
  // New chat means a chat of the owner's own; opening Chats bare means KOS's front door.
  useEffect(() => setMode(landingMode(composing)), [composing]);
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
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** The New project dialog, from the rail's +. */
  const [makingProject, setMakingProject] = useState(false);
  /** The chat being renamed, with its title as the field starts. */
  /** The chat whose brief is being handed to another, from the menu. */
  const [handingOff, setHandingOff] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(
    null,
  );
  /** The ⋯ that opened the row's menu: the one menu hangs from it and gives the focus back to it. */
  const menuAnchor = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);
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
  // Said once as a turn starts here: the thread is busy until it ends, and its reply is then read as it lands.
  const workingSince = live && !live.ended ? live.since : undefined;
  useEffect(() => {
    if (workingSince !== undefined) announce("KOS is working");
  }, [workingSince]);
  // A finished turn keeps its steps on screen until the transcript arrives,
  // so "there is a live view" and "work is happening" are no longer the same
  // question.
  const working = Boolean(live) && !live?.ended;
  const running = working || sendingIn === activeId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  /**
   * How much of a long chat is read: its newest `CHAT_WINDOW` events, more
   * at each Show earlier, back to that on opening another chat; and what is
   * left above them.
   */
  const shownRef = useRef(CHAT_WINDOW);
  const [cut, setCut] = useState<{ earlier: number; ownerAbove: number }>({ earlier: 0, ownerAbove: 0 });
  const readChat = (id: string): ReturnType<typeof api.conversation> => api.conversation(id, shownRef.current);
  const showChat = (got: Awaited<ReturnType<typeof api.conversation>>): void => {
    setEvents(got.events);
    setCut({ earlier: got.earlier ?? 0, ownerAbove: got.ownerAbove ?? 0 });
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [trigger, setTrigger] = useState<Trigger | null>(null);
  // The server's channels, so "#name" in a chat is coloured and chipped as
  // the channel; none when KOS lives in no server.
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api
      .discordChannels()
      .then((r) => {
        if (!cancelled) setChannels(r.channels);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const channelNames = useMemo(() => new Set(channels.map((c) => c.name.toLowerCase())), [channels]);
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
        // The steps beside the model's words for them: /approve is a yes too.
        label: [a.summary ?? summarizeAction(a.tool, a.args), a.mechanics ?? stepMechanics(a.tool, a.args)].filter(Boolean).join(" · "),
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
  const threadScroll = useOverlayScroll(boxRef);
  const railScroll = useOverlayScroll<HTMLDivElement>();
  const inlineScroll = useOverlayScroll<HTMLDivElement>();

  const active = conversations.find((c) => c.id === activeId);
  useAutoGrow(inputRef, draft, 12, active?.id);
  // A chat the address names that is in no list, archived included: said so, not the landing in its place.
  const strayKey = activeId && !active && !loading && !project && !agent ? `chat:${activeId}` : null;
  const stray = useFound(strayKey, () => api.conversations(true).then((all) => all.some((c) => c.id === activeId)));
  // Opening a chat puts the cursor in its box: that is what you came to do. Keyed on the chat being drawn, not
  // on its id alone: the box is not there until the list has the chat, and focus was left on the page. Not over
  // something else that has the focus (a dialog, a field), and not on a phone, where it would raise the keyboard.
  const shownId = active?.id;
  useEffect(() => {
    if (!shownId || narrow) return;
    const held = document.activeElement;
    if (held && held !== document.body && !held.closest(".side, .chats-list")) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [shownId, narrow]);
  const [chatMode, setChatMode] = useChatMode(active, onChanged);
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
  /*
   * A turn writes its steps to the transcript as they land, so one loaded
   * mid-turn ends with them. While the live view holds them too, it draws
   * them, with their pictures and the words heard on the way; the
   * transcript's copy waits until the turn hands over.
   */
  const liveHasSteps = live?.steps.some((s) => s.kind === "tool") === true;
  const visible = [...seeded, ...(liveHasSteps ? events.slice(0, runningTail(events)) : events)];
  /** The owner's words a running turn is for, said somewhere else and not yet in the transcript. */
  const liveSaid = live?.said && !visible.some((e) => e.kind === "message" && e.role === "you" && e.text === live.said) ? live.said : undefined;
  /** The day and pause lines over the messages, and over those words, from when each was said. */
  const times = [...visible.map((e) => (e.kind === "message" ? e.at : undefined)), liveSaid && live && !live.resumed ? live.since : undefined];
  // Worked out again only when a time changes, not on every stream tick.
  const timesKey = times.join(",");
  const marks = useMemo(() => timeMarks(times), [timesKey]);
  const liveMark = marks[visible.length];

  /**
   * The words for a reference, where this view knows them. A chat and a
   * build are addressed by id, and an id is not a name. A blob (@blob:, and
   * @agent: from before blobs had their name) is addressed by its name.
   */
  const artifactTitles = useArtifactTitles();
  const nameFor = (kind: string, id: string): string | undefined => {
    if (kind === "chat") return conversations.find((c) => c.id === id)?.title;
    // An artifact by its title; its id while the list is still coming.
    if (kind === "page") return artifactTitles.get(id);
    if (kind === "build") {
      const build = agents.find((b) => String(b.id) === id);
      return build ? build.dir : undefined;
    }
    if (kind === "tab") {
      const tab = tabs.find((t) => t.id === id);
      return tab ? tabName(tab) : "a closed tab";
    }
    // A job is referred to by its number, which outlives a rename; shown by name.
    if (kind === "schedule") return crons.find((c) => String(c.id) === id)?.name;
    // A channel is a chip only when it is one; "#3" in a sentence is not.
    if (kind === "channel") return channelNames.has(id.toLowerCase()) ? `#${id}` : undefined;
    return undefined;
  };
  /** A channel opens on Discord; everything else has a page here. */
  const channelLink = (name: string): string | undefined => channels.find((c) => c.name.toLowerCase() === name.toLowerCase())?.url;
  // The guild base of a Discord URL (https://discord.com/channels/<guild>),
  // taken from any channel's own url, so a thread links by its id the way a
  // channel links by name.
  const discordBase = useMemo(() => {
    const u = channels.find((c) => c.url)?.url;
    const cut = u ? u.lastIndexOf("/") : -1;
    return cut > 0 ? u!.slice(0, cut) : undefined;
  }, [channels]);
  const roomLink = (room: { kind: string; id?: string; name?: string }): string | undefined =>
    room.id && discordBase ? `${discordBase}/${room.id}` : room.kind === "channel" && room.name ? channelLink(room.name) : undefined;
  const channelHref = (kind: string, id: string): string | undefined => (kind === "channel" ? channelLink(id) : undefined);

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
      shownRef.current = CHAT_WINDOW;
      setCut({ earlier: 0, ownerAbove: 0 });
      setEvents([]);
      setEditing(false);
      setEditingIndex(null);
    }
    let cancelled = false;
    const id = activeId;
    void readChat(id)
      .then((got) => {
        const waiting = got.pending;
        if (cancelled) return;
        /*
         * Queued messages land first, always.
         *
         * They arrive on the same fetch as the transcript, and holding the
         * transcript still during a turn held these back with it -- so a
         * message queued behind a running turn stayed invisible until the
         * turn ended, which is the one moment it did not matter.
         */
        showPending(id, waiting);
        /*
         * The transcript itself waits.
         *
         * A conversation is touched more than once per turn, and replacing
         * the whole transcript under a streaming answer is what made a turn
         * look like it was redrawing itself. loadedFor is left alone too, so
         * the fetch happens again once the turn is over.
         */
        if (holdTranscript) return;
        showChat(got);
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

  /*
   * The message a search opened this chat at (`?at=` on the address, an
   * index into the transcript the view draws): scrolled to and lit once
   * the transcript is here, and taken off the address so a reload opens
   * at the newest message again.
   */
  const [at, clearAt] = useHashParam("at");
  const [foundAt, setFoundAt] = useState<number | null>(null);
  useEffect(() => setFoundAt(null), [activeId]);
  useEffect(() => {
    if (at === undefined || !activeId || loadedFor?.id !== activeId) return;
    const index = Number(at);
    if (!Number.isInteger(index) || index < 0) return void clearAt();
    // Above what is read: read back to it first, and come here again when it is in.
    if (index < cut.earlier) {
      shownRef.current = cut.earlier + events.length - index + CHAT_WINDOW / 4;
      void readChat(activeId).then((got) => activeIdRef.current === activeId && showChat(got)).catch(() => clearAt());
      return;
    }
    clearAt();
    if (index - cut.earlier < events.length) setFoundAt(index - cut.earlier);
  }, [at, activeId, loadedFor, events.length, cut.earlier, clearAt]);
  useEffect(() => {
    if (foundAt === null) return;
    // Again a frame on, after the thread has followed its newest message down.
    const show = (): void => boxRef.current?.querySelector(".bubble.is-found")?.scrollIntoView({ block: "center" });
    show();
    const frame = requestAnimationFrame(show);
    return () => cancelAnimationFrame(frame);
  }, [foundAt]);

  // The live turn grows as it streams, so it is part of what pins the scroll.
  useStickToBottom(boxRef, [events, sendingIn, activeId, live?.steps.length, live?.text, asides.length], `${activeId}:${sendingIn === activeId}`);

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
  /*
   * Agent mode. The agent's own thread is agent:<name>; the chats it runs
   * inside projects are the ones stamped with its role. Its file and
   * schedule are the panel's business.
   */
  const agentThread = agent ? conversations.find((c) => c.id === `agent:${agent.name}`) : undefined;
  const agentInstances = useMemo(
    () => (agent ? conversations.filter((c) => c.kind === "chat" && c.role === agent.name && !c.archived).sort(byAttention) : []),
    [agent, conversations],
  );
  /*
   * What the project or the blob owns, beside its chat, and the one open in
   * place of the thread. A blob owns what its own thread makes, as it owns
   * its folder; a project, what its chats make.
   */
  const [inline, setInline] = useState<string>();
  const projectSlug = project?.slug;
  const agentName = agent?.name;
  const railOwner = useMemo<RailOwner | undefined>(
    () => (agentName ? { blob: agentName } : projectSlug ? { project: projectSlug } : undefined),
    [agentName, projectSlug],
  );
  // Read again when what was open in place closes, since the owner may have edited it there.
  const owned = useOwnedArtifacts(railOwner, inline);
  // Another project, blob or thread: the thread is what shows, not the artifact open before, once its editing is finished.
  const viewer = useRef<ViewerHandle>(null);
  const shown = useRef(inline);
  useEffect(() => {
    shown.current = inline;
  }, [inline]);
  useEffect(() => {
    let stale = false;
    // Closed only if it is still the one being finished: one opened during the wait stays.
    const settling = shown.current;
    void (viewer.current?.settle() ?? Promise.resolve()).then(() => !stale && setInline((now) => (now === settling ? undefined : now)));
    return () => {
      stale = true;
    };
  }, [projectSlug, agentName, activeId]);
  const openOwned = (a: PageSummary): void => {
    // An older widget page has no viewer of its own here; it opens on its page.
    if (a.kind !== "html") (project ?? agent)?.onOpenPage(a.id);
    else setInline(a.id);
  };
  const railProps = { items: owned, ...(inline ? { open: inline } : {}), onOpen: openOwned };
  // An artifact a turn made opens on its own page, or here in place of the thread, as the rail opens one.
  const artifactOpeners = useMemo<ArtifactOpeners>(
    () => ({ projects, open: (id) => void (window.location.hash = hrefFor({ name: "artifacts", id })), beside: setInline }),
    [projects],
  );

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
    // Listed means the manifest has it, so it can be deleted; a thread whose
    // project is already gone has only its own chat menu for that.
    const rows = projects
      .filter((p) => p.status !== "archived")
      .map((p) => {
        const thread = threads.get(p.slug);
        return { slug: p.slug, name: p.name, type: p.type, colour: p.colour ?? null, thread, busy: busy(p.slug, thread), listed: true };
      });
    for (const [slug, c] of threads) {
      if (!rows.some((r) => r.slug === slug)) {
        rows.push({ slug, name: c.title, type: "project", colour: null, thread: c, busy: busy(slug, c), listed: false });
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [conversations, projects, tree, progress]);
  // Maintenance is where KOS repairs itself, not work of the owner's: it
  // waits at the foot of the rail with the archive, out of the projects.
  const systemProjects = projectRows.filter((p) => p.type === "system");
  const shownProjects = projectRows.filter(
    (p) => p.type !== "system" && (!q || p.name.toLowerCase().includes(q) || (tree.byProject.get(p.slug) ?? []).some(matches)),
  );
  const ownProjects = projectRows.length - systemProjects.length;
  const shownSurfaces = surfaces.filter((c) => !q || surfaceName(c.channel ?? c.title).toLowerCase().includes(q));
  const shownKos = orchestrator !== undefined && matches(orchestrator);
  const shownArchived = archived.filter(matches);
  /** A stream with something to say: only then does its row carry a dot. */
  const stirring = (c: Conversation): boolean =>
    waitingOn.has(c.id) ||
    (progress[c.id] !== undefined && !progress[c.id]!.ended) ||
    (c.activity !== undefined && c.activity !== "idle") ||
    Boolean(c.unread);
  const folds = useRailFolds(SHUT_BY_DEFAULT);
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
  // How tall a project's schedule stands under its agents, and whether it is folded to its head.
  const [schedH, setSchedH] = useState(() => readWidth(SCHED_H));
  const [schedShut, setSchedShut] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SCHED_SHUT_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SCHED_SHUT_KEY, schedShut ? "1" : "0");
    } catch {
      // Remembered for this visit only.
    }
  }, [schedShut]);
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
  const rememberPanel = (): void => {
    const next = !panelOpen;
    setPanelOpen(next);
    try {
      localStorage.setItem("kos.project.panel", next ? "1" : "0");
    } catch {
      // Remembered for this visit only.
    }
  };
  /*
   * Without the room for a third column the panel is a drawer over the chat,
   * opened by the same toggle and shut by it, the backdrop or Escape, and not
   * remembered: the next narrow visit starts on the chat.
   */
  const root = useRef<HTMLDivElement>(null);
  const panelFits = useRoomFor(root, PANEL_ROOM);
  const drawer = usePanelDrawer(root, panelFits);
  const panelShown = panelFits ? panelOpen : drawer.open;
  const togglePanel = (): void => (panelFits ? rememberPanel() : drawer.toggle());

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
      if (!panelShown) togglePanel();
      onNotice("The project's files are in the panel on the right.");
    } else if (active?.projectSlug) {
      onOpenProject(active.projectSlug);
    } else {
      window.location.hash = hrefFor({ name: "files" });
    }
    return true;
  };

  /**
   * Sends what is in the composer, or, given words, those words alone: a
   * typed block's Send speaks for the owner and leaves the composer as it is.
   */
  /**
   * Send what the composer holds; or words said another way (`spoken`); or,
   * `again`, a message that did not reach KOS, from its bubble, which leaves
   * whatever the composer holds now alone.
   */
  async function send(spoken?: string, again?: Unsent): Promise<void> {
    const composed = spoken === undefined && again === undefined;
    const text = again ? again.text : composed ? draft.trim() : (spoken ?? "");
    const target = activeId;
    if ((!text && (!composed || attachments.files.length === 0) && !again?.files.length) || !target) return;
    // Nothing goes while KOS is not answering: the words stay in the box until it is back.
    if (reach.down) return;
    if (composed && runLocally(text)) {
      setDraft("");
      return;
    }
    // The message is sent the moment Send is pressed, so it should read that
    // way: the bubble carries its attachments straight away and the composer
    // is empty. Waiting for the turn meant the files sat in the composer,
    // looking unsent, until the answer came back.
    const files = again ? again.files : composed ? attachments.files : [];
    // A command is not part of the conversation, so it gets no bubble: one
    // appeared and was taken away again by the reload a moment later.
    const looksLikeCommand = /^\/\S/.test(text) && files.length === 0;
    /*
     * Not blocked while a turn runs: the turn hears it at its next step, or
     * it runs next. A bubble in the transcript would draw it above the
     * running turn's steps and words, so it waits under the turn instead,
     * and the live view puts it where the turn took it in.
     */
    // The rows waiting now: none of them is this message.
    const before = pending.map((p) => p.id);
    const aside: Aside | null =
      running && !looksLikeCommand
        ? {
            key: ++asideKeys.current,
            conversationId: target,
            text,
            attachments: files.map((f) => ({ name: f.name })),
            at: Date.now(),
            before,
            ...(live ? { turn: live.since } : {}),
            steps: live?.steps.length ?? 0,
          }
        : null;
    if (aside) setAsides((a) => [...a, aside]);
    else setSendingIn(target);
    // Kept by reference, so a send that fails takes back just this bubble.
    const bubble: ChatEvent = {
      kind: "message",
      role: "you",
      text,
      at: Date.now(),
      ...(files.length
        ? {
            attachments: files.map((f) => ({
              name: f.name,
              ...(f.mediaType.startsWith("image/") ? { src: `data:${f.mediaType};base64,${f.data}` } : {}),
            })),
          }
        : {}),
    };
    if (!looksLikeCommand && !aside) setEvents((e) => [...e, bubble]);
    if (composed) {
      setDraft("");
      attachments.clear();
    }

    try {
      const res = await api.message(text, target, files);
      if (aside) setAsides((a) => answeredAside(a, aside, res));
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
      const got = await readChat(target);
      if (target === activeIdRef.current) showChat(got);
      showPending(target, got.pending);
      // Every path that replaces the transcript is a handover: leaving the
      // finished steps up as well shows each tool call twice until something
      // else happens to clear them.
      settleProgress(target);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      /*
       * Back in the composer only when it is not waiting on the server: an
       * answer lost on the way back can follow a message that was queued all
       * the same, and that one shows as its row. Put back as well, it would
       * be sent twice.
       */
      const waiting = await readChat(target).then((r) => r.pending).catch(() => undefined);
      if (waiting) showPending(target, waiting);
      const unsent = !waiting || !queuedAnyway(waiting, before, text);
      // The owner's own bubble stays, marked as not sent and why, where KOS's reply would have gone before.
      // Never the browser's words in KOS's slot: that read as KOS answering "Error: Failed to fetch".
      // Its words and files are kept with it, for Retry or Edit, and not put back in the composer as well:
      // in both places, Send and Retry sent it twice.
      const home = unsentHome({ reached: !unsent, command: looksLikeCommand, midTurn: aside !== null });
      if (home === "bubble") unsentFiles.current.set(bubble, files);
      setEvents((e) => (home === "bubble" ? e.map((x) => (x === bubble ? { ...bubble, unsent: msg } : x)) : e.filter((x) => x !== bubble)));
      if (looksLikeCommand || aside) onNotice(msg);
      if (composed && home === "composer") {
        setDraft((d) => backInComposer(d, text));
        attachments.restore(files);
      }
    } finally {
      if (aside) setAsides((a) => a.filter((x) => x !== aside));
      else setSendingIn((id) => (id === target ? null : id));
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
      const { pending: waiting } = await readChat(id);
      showPending(id, waiting);
    } catch {
      // The list is refreshed on the next turn either way.
    }
  };

  const saveQueued = async (id: number): Promise<void> => {
    const draftText = editingQueued?.text.trim();
    if (!draftText || !activeId) return;
    try {
      const { pending: waiting } = await api.editPending(id, draftText, activeId);
      showPending(activeId, waiting);
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
      showPending(activeId, waiting);
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
        const got = await readChat(target);
        settleProgress(target);
        showPending(target, got.pending);
        if (target !== activeIdRef.current) return;
        showChat(got);
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

  // What a typed block in KOS's words may do here: name a tool this KOS has, and say so to KOS in this chat.
  const ask = useStable((text: string) => void send(text));
  const blockActions: BlockActions = useMemo(() => ({ tools: toolNames, ask }), [toolNames, ask]);
  // A new identity when the rooms it links to are known, so a message drawn before the channels loaded gains its link.
  const linkFor = useCallback(roomLink, [discordBase, channels]); // the room link reads nothing else
  /** What the owner does to one of their turns: one handler for every message, so a message redraws only when it changes. */
  const onTurn = useStable((what: TurnAction, turn: number) => {
    if (what === "edit") setEditingIndex(turn);
    else rewind(turn, what === "fork" ? { forkTitle: "" } : {});
  });

  /** Reads the chat back another window's worth; how many more events it shows. */
  const showEarlier = async (): Promise<number> => {
    if (!activeId) return 0;
    const id = activeId;
    const had = events.length;
    shownRef.current += CHAT_WINDOW;
    const got = await readChat(id);
    if (id !== activeIdRef.current) return 0;
    showChat(got);
    return Math.max(0, got.events.length - had);
  };
  const away = useAwayFromLatest(boxRef);
  const threadWho = active ? (active.kind === "orchestrator" ? "KOS" : active.title) : "KOS";

  const renderEvent = (e: ChatEvent, i: number, turn: number, lastAt?: number): ReactElement => {
    if (e.kind === "tool") {
      return (
        <ToolCall
          key={i}
          event={e}
          waiting={e.pendingId !== undefined && pendingApprovals.has(e.pendingId)}
          ask={approvals.find((a) => String(a.id) === e.pendingId)}
          onDecide={onDecide}
          deciding={deciding}
        />
      );
    }
    if (e.kind === "reasoning") return <Thinking key={i} text={e.text} />;
    // Where the chat was cleared or compacted: a line, so what is above reads
    // as kept for the owner and not as what KOS still has in mind.
    if (e.kind === "divider") {
      return (
        <div key={i} className="chat-divider" role="separator" title={new Date(e.at).toLocaleString()}>
          <span>{e.text}</span>
        </div>
      );
    }

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

    const said = <MessageTurn key={i} event={e} turn={turn} actions={blockActions} linkFor={linkFor} busy={rewinding} onTurn={onTurn} found={i === foundAt} {...(lastAt !== undefined ? { lateAfter: lastAt } : {})} />;
    if (e.kind !== "message" || e.unsent === undefined) return said;
    return (
      <Fragment key={i}>
        {said}
        <UnsentNote
          reason={e.unsent}
          down={reach.down}
          onRetry={() => {
            // Sent again from the bubble, which the send draws anew; the composer is left as it is.
            const files = unsentFiles.current.get(e) ?? [];
            unsentFiles.current.delete(e);
            setEvents((all) => all.filter((x) => x !== e));
            void send(undefined, { text: e.text, files });
          }}
          onEdit={() => {
            // Back in the composer to change, and gone from the thread, so it is in one place only.
            const files = unsentFiles.current.get(e) ?? [];
            unsentFiles.current.delete(e);
            setEvents((all) => all.filter((x) => x !== e));
            setDraft((d) => backInComposer(d, e.text));
            attachments.restore(files);
            inputRef.current?.focus();
          }}
        />
      </Fragment>
    );
  };

  /** One chat in the list, at the root or under its project. */
  /** A row for a chat; `label` says what to call it where its own title would not tell rows apart. */
  const renderChat = (c: Conversation, label?: string): ReactElement => (
      <li key={c.id}>
        {/* Hover reveals what can be done with a chat, so the list is
            a list until you need it to be more. */}
        <div className="chats-row">
          <IconButton
            className="chats-more"
            label={`Actions for ${c.title}`}
            aria-haspopup="menu"
            aria-expanded={menuFor === c.id}
            onClick={(e) => {
              e.stopPropagation();
              menuAnchor.current = e.currentTarget;
              setMenuFor(menuFor === c.id ? null : c.id);
            }}
          >
            <MoreIcon />
          </IconButton>
          <Menu
            open={menuFor === c.id}
            onClose={closeMenu}
            anchor={menuAnchor}
            label={`Actions for ${c.title}`}
            items={[
              // Renaming was only reachable by typing /rename, which is a strange thing to have to know for the one bit of a chat the owner is most likely to change.
              { label: "Rename", act: () => setRenaming({ id: c.id, title: c.title }) },
              {
                label: "Duplicate",
                act: () =>
                  void api
                    .rewind(c.id, 0, { forkTitle: `${c.title} copy` })
                    .then((r) => {
                      onChanged();
                      onOpen(r.conversationId);
                    })
                    .catch(() => undefined),
              },
              { label: "Hand off…", act: () => setHandingOff({ id: c.id, title: c.title }) },
              {
                label: showArchived ? "Unarchive" : "Archive",
                // Said, with Undo, as Archive in the chat's head is: the row going was all there was to see.
                act: () =>
                  void api.archiveConversation(c.id, !showArchived).then(() => {
                    onChanged();
                    if (!showArchived) setUndo({ id: c.id, title: c.title });
                    else toast({ kind: "ok", text: `Unarchived “${c.title}”` });
                  }),
              },
            ]}
          >
            {/* Asked once, beside the item: delete is the one thing here that cannot be undone, and a menu item that does it on one click is a trap beside Archive. */}
            <ConfirmButton
              role="menuitem"
              className="kos-menu-row is-danger"
              label="Delete"
              text={`Delete “${c.title}”?`}
              onConfirm={() => {
                setMenuFor(null);
                void api.deleteConversation(c.id).then(onChanged);
              }}
            />
          </Menu>
          <a
          className={`chats-item ${c.id === activeId ? "is-active" : ""}`}
          href={hrefOf(c)}
          aria-current={c.id === activeId ? "page" : undefined}
          aria-label={chatRowWords(label ?? c.title, c, { waiting: waitingOn.has(c.id), working: Boolean(progress[c.id] && !progress[c.id]!.ended), ...(c.queued ? { queued: c.queued } : {}) })}
          onClick={(e) => {
            e.preventDefault();
            onOpen(c.id);
          }}
        >
          {c.id === activeId && (
            <m.span className="chats-active-bar" layoutId="chat-active" transition={spring} />
          )}
          <span className="chats-item-top">
            {/* A thread mid-turn, sitting on an approval or broken looked
                exactly like an idle one, and the only way to find out was
                to open it. A dot says which, and leaves the time alone. */}
            <span className="chats-lead">
              <ThreadDot live={progress[c.id]} chat={c} waiting={waitingOn.has(c.id)} />
            </span>
            {/* An agent working inside a project wears its role's face. */}
            {c.role && <Face seed={c.role} size={16} mood={moodOf(c.activity)} />}
            <span className="chats-item-title">{label ?? c.title}</span>
            <QueuedMark n={c.queued} />
            <span className="chats-item-when"><When at={c.updatedAt} /></span>
          </span>
          {/* Title and state only. The brief and the tool list made every
              row a paragraph; a chat's details are one click away. */}
          </a>
        </div>
      </li>
  );

  /** The list's show/hide, wherever the view is: a thread's head, or the landing. */
  const listToggle = (
    <IconButton
      className={`chats-toggle ${collapsed && !narrow ? "" : "is-on"}`}
      label={narrow ? "Show chats" : collapsed ? "Show the chat list" : "Hide the chat list"}
      aria-pressed={!(collapsed && !narrow)}
      title={narrow ? "Show chats" : collapsed ? "Show the chat list" : "Hide the chat list"}
      onClick={() => (narrow ? setListOpen(true) : setCollapsed((v) => !v))}
    >
      <PanelIcon side="left" on={!(collapsed && !narrow)} />
    </IconButton>
  );

  return (
    <ArtifactOpen.Provider value={artifactOpeners}>
      <div
        className={`chats ${collapsed && !narrow ? "is-collapsed" : ""} ${narrow ? "is-narrow" : ""} ${active || composing ? "has-view" : ""} ${listOpen ? "is-list-open" : ""} ${project || agent ? "is-project" : ""} ${(project || agent) && panelFits && !panelOpen ? "panel-hidden" : ""} ${(project || agent) && drawer.open ? "is-panel-drawer" : ""} ${resizing ? "is-resizing" : ""}`}
        ref={root}
        style={{ "--rail-w": `${railW}px`, "--panel-w": `${panelW}px` } as CSSProperties}
      >
        {narrow && listOpen && (
          <div className="chats-backdrop" aria-hidden="true" onClick={() => setListOpen(false)} />
        )}
        {project ? (
          /* The project's own rail: its orchestrator above, its agents below,
             and nothing from outside it. Back is the way out. */
          <aside className="chats-list chats-list--project" aria-label="Chats in this project" onKeyDown={railRowKeys}>
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
                      ? `${kindWord(projectRecord.type)} · ${projectRecord.description}`
                      : kindWord(projectRecord.type)
                    : "Not in the project list"}
                </span>
              </div>
              <SearchField className="chats-find" noun="chats" value={query} onChange={setQuery} onKeyDown={railSearchKeys} />
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
                      <ThreadDot live={progress[projectOrchestrator.id]} chat={projectOrchestrator} waiting={waitingOn.has(projectOrchestrator.id)} />
                      <QueuedMark n={projectOrchestrator.queued} />
                    </span>
                    <span className="chats-root-sub">Plans the project's work and hands it to its agents</span>
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
            <div className="label chats-group-head">
              <span>Agents</span>
              {/* Like New chat: the thread opens empty and the first message
                  names it. A form asking for a name, a brief and a task first
                  was three fields in the way of saying what you wanted. */}
              <button
                type="button"
                className="chats-group-add"
                aria-label="New agent"
                title="Start an agent: a chat for one piece of this project's work, named by its first message"
                disabled={creating}
                onClick={() => void startAgent()}
              >
                +
              </button>
            </div>
            <ul className="chats-flat">
              {shownAgents.map((c) => renderChat(c))}
              {shownAgents.length === 0 && (
                <li>
                  {q ? (
                    <EmptyState variant="inline" className="chats-empty" query={{ noun: "agents", onClear: () => setQuery("") }} />
                  ) : (
                    <EmptyState variant="inline" loading={loading} className="chats-empty">No agents yet. The orchestrator starts them as work comes up, or start one with +.</EmptyState>
                  )}
                </li>
              )}
            </ul>
            {/* The project's schedule, under its agents: a job that works this
                project belongs with it, as its agents do, rather than in one
                list of everything KOS runs. The line between is the owner's
                to drag: the two lists used to split the rail in half whatever
                was in them, so a project with one job gave it half the column. */}
            {!narrow && (
              <Gutter
                className="chats-gutter--sched"
                label="the schedule"
                value={schedH}
                min={SCHED_H.min}
                max={SCHED_H.max}
                fallback={SCHED_H.fallback}
                grows="up"
                onChange={setSchedH}
                onDone={(h) => saveWidth(SCHED_H, h)}
                collapsed={schedShut}
                onCollapse={() => setSchedShut(true)}
                onExpand={() => setSchedShut(false)}
              />
            )}
            <div className={`chats-sched ${schedShut ? "is-shut" : ""}`} style={!narrow && !schedShut ? { height: schedH } : undefined}>
              <div className="label chats-group-head">
                <button
                  type="button"
                  className="chats-group-fold"
                  aria-expanded={!schedShut}
                  title={schedShut ? "Show the schedule" : "Fold the schedule away"}
                  onClick={() => setSchedShut((v) => !v)}
                >
                  Schedule
                </button>
                <button
                  type="button"
                  className="chats-group-add"
                  aria-label="New schedule"
                  title="A new schedule for this project"
                  onClick={() => onEditCron(undefined, project.slug)}
                >
                  +
                </button>
              </div>
              <ul className="chats-flat">
                {crons
                  .filter((c) => c.projectSlug === project.slug)
                  .map((c) => (
                    <li key={c.id}>
                      <button type="button" className="chats-item chats-job" onClick={() => onEditCron(c)} title="Edit this schedule">
                        <span className="chats-item-top">
                          <StatusDot state={c.running ? "working" : c.enabled ? "on" : "off"} label={STATE_WORDS[c.running ? "running" : c.enabled ? "on" : "off"].word} />
                          <span className="chats-item-title">{jobTitle(c.name)}</span>
                          <span className="chats-item-when" title={c.schedule}>{scheduleWords(c.schedule)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                {crons.every((c) => c.projectSlug !== project.slug) && (
                  <li><EmptyState variant="inline" loading={loading} className="chats-empty">Nothing scheduled for this project. Add one with +, or ask the orchestrator.</EmptyState></li>
                )}
              </ul>
            </div>
          </aside>
        ) : agent ? (
          /* The agent's own rail: its thread above, the chats it runs inside
             projects below. Back is the way out. */
          <aside className="chats-list chats-list--project" aria-label="Chats in this project" onKeyDown={railRowKeys}>
            <div className="chats-list-head">
              <button type="button" className="chats-back" onClick={agent.onBack}>
                <ChevronLeft size={14} />
                All blobs
              </button>
              <div className="chats-project-head">
                <span className="chats-project-name">{agentThread?.title ?? agent.name}</span>
                <span className="chats-project-sub">A blob</span>
              </div>
            </div>
            <div className="chats-pinned">
              {agentThread && (
                <a
                  className={`chats-root ${agentThread.id === activeId ? "is-active" : ""}`}
                  href={hrefOf(agentThread)}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(agentThread.id);
                  }}
                >
                  <Face seed={agent.name} size={26} mood={moodOf(agentThread.activity)} />
                  <span className="chats-root-text">
                    <span className="chats-root-title">
                      {agentThread.title}
                      <ThreadDot live={progress[agentThread.id]} chat={agentThread} waiting={waitingOn.has(agentThread.id)} />
                      <QueuedMark n={agentThread.queued} />
                    </span>
                    <span className="chats-root-sub">Its own chat: talk to it here, and its schedule runs here</span>
                  </span>
                </a>
              )}
              <div className="label chats-group-head">
                <span>In projects</span>
              </div>
              <ul className="chats-flat">
                {/* Every instance carries the agent's own name, so the row is
                    named for the project it is in: that is what tells them apart. */}
                {agentInstances.map((c) => renderChat(c, c.projectSlug ? projectName(c.projectSlug) : c.title))}
                {agentInstances.length === 0 && (
                  <li><EmptyState variant="inline" loading={loading} className="chats-empty">Not working in any project. A project's orchestrator can give it work there.</EmptyState></li>
                )}
              </ul>
            </div>
          </aside>
        ) : (
          <aside className="chats-list chats-list--root" aria-label="Chats" onKeyDown={railRowKeys}>
            <div className="chats-list-head chats-list-head--root">
              <SearchField className="chats-find" noun={showArchived ? "archived chats" : "chats"} value={query} onChange={setQuery} onKeyDown={railSearchKeys} />
              {/* New chat opens the landing, where you choose a chat, a project,
                  or hand it to KOS, rather than dropping into an empty thread.
                  A square beside the search rather than a bar of its own: it
                  took the rail's whole first row to say two words. */}
              <IconButton
                className="chats-compose"
                label="New chat"
                title="New chat"
                onClick={() => {
                  if (narrow) setListOpen(false);
                  window.location.hash = hrefFor({ name: "chats", compose: true });
                }}
              >
                <ComposeIcon />
              </IconButton>
            </div>
            {onCreateProject && <NewProjectDialog open={makingProject} onClose={() => setMakingProject(false)} onCreate={onCreateProject} taken={projects.map((p) => p.name)} />}

            {/* One scroll for the whole rail. The projects used to stand still
                while only the chats under them scrolled, so with ten projects
                the chats had a strip at the bottom of the screen. */}
            <div className="chats-scroll" ref={railScroll}>
              {showArchived ? (
                <section className="rail-group is-open">
                  <div className="rail-group-head">
                    <span className="rail-group-fold">
                      <span className="rail-group-title">Archived</span>
                      {shownArchived.length > 0 && <Count n={shownArchived.length} />}
                    </span>
                  </div>
                  <ul className="chats-flat">
                    {shownArchived.map((c) => renderChat(c))}
                    {shownArchived.length === 0 && <li>{q ? <EmptyState variant="inline" className="chats-empty" query={{ noun: "chats", onClear: () => setQuery("") }} /> : <EmptyState variant="inline" className="chats-empty">Nothing archived.</EmptyState>}</li>}
                  </ul>
                </section>
              ) : loading ? (
                /* The rail's rows' places until its chats and projects are both read: drawn group by group as each
                   arrived, the Projects group grew under the pointer and pushed Chats down a hundred pixels. */
                <EmptyState loading itemHeight={34} className="chats-rail-loading" />
              ) : (
                <>
                  {/* The streams: KOS, which routes the work, and each surface's
                      one continuous thread. Ways in rather than threads being
                      worked in, so they lead and do not fold. */}
                  {(shownKos || shownSurfaces.length > 0) && (
                    <ul className="chats-streams">
                      {orchestrator && shownKos && (
                        <li>
                          <a
                            className={`chats-item ${orchestrator.id === activeId ? "is-active" : ""}`}
                            href={hrefFor({ name: "chats", id: orchestrator.id })}
                            title="Routes your work to projects and blobs"
                            onClick={(e) => {
                              e.preventDefault();
                              onOpen(orchestrator.id);
                            }}
                          >
                            {orchestrator.id === activeId && (
                              <m.span className="chats-active-bar" layoutId="chat-active" transition={spring} />
                            )}
                            <span className="chats-item-top">
                              <span className="chats-lead">
                                <Face seed={KOS_SEED} look={faceLookOf(kos)} size={18} mood={moodOf(orchestrator.activity)} label="KOS" />
                              </span>
                              <span className="chats-item-title chats-item-title--strong">{orchestrator.title}</span>
                              {stirring(orchestrator) && <ThreadDot live={progress[orchestrator.id]} chat={orchestrator} waiting={waitingOn.has(orchestrator.id)} />}
                            </span>
                          </a>
                        </li>
                      )}
                      {shownSurfaces.map((c) => (
                        <li key={c.id}>
                          <a
                            className={`chats-item ${c.id === activeId ? "is-active" : ""}`}
                            href={hrefFor({ name: "chats", id: c.id })}
                            title={`Everything said on ${surfaceName(c.channel ?? c.title)} arrives here`}
                            onClick={(e) => {
                              e.preventDefault();
                              onOpen(c.id);
                            }}
                          >
                            {c.id === activeId && <m.span className="chats-active-bar" layoutId="chat-active" transition={spring} />}
                            <span className="chats-item-top">
                              <span className="chats-lead chats-lead--glyph">
                                <HashIcon />
                              </span>
                              <span className="chats-item-title">{surfaceName(c.channel ?? c.title)}</span>
                              {stirring(c) && <ThreadDot live={progress[c.id]} chat={c} waiting={waitingOn.has(c.id)} />}
                              <span className="chats-item-when"><When at={c.updatedAt} /></span>
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}

                  {(!q || shownProjects.length > 0) && (
                    <RailGroup
                      title="Projects"
                      count={shownProjects.length}
                      open={q !== "" || folds.isOpen("projects")}
                      {...(q ? {} : { onToggle: () => folds.toggle("projects") })}
                      action={
                        onCreateProject && (
                          <IconButton
                            className="rail-group-add"
                            label="New project"
                            title="Make an empty project: a chat of its own, and nothing else until something is put there"
                            onClick={() => setMakingProject(true)}
                          >
                            +
                          </IconButton>
                        )
                      }
                    >
                      {ownProjects === 0 ? (
                        <EmptyState variant="inline" loading={loading} className="chats-group-empty">None yet. Make one with +, or ask KOS and it stands one up when the work needs its own space.</EmptyState>
                      ) : (
                        /* A row is the project. It opens as its own page, with
                           its orchestrator and agents; nothing unfolds here. */
                        <ul className="chats-projects">
                          {shownProjects.map((p) => {
                            // Keyed apart from the chats' menus: a project's own
                            // thread is a conversation with an id of its own.
                            const menuKey = `proj:${p.slug}`;
                            return (
                              <li key={p.slug}>
                                <div className="chats-row">
                                  {onDeleteProject && p.listed && (
                                    <IconButton
                                      className="chats-more"
                                      label={`Actions for ${p.name}`}
                                      aria-haspopup="menu"
                                      aria-expanded={menuFor === menuKey}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        menuAnchor.current = e.currentTarget;
                                        setMenuFor(menuFor === menuKey ? null : menuKey);
                                      }}
                                    >
                                      <MoreIcon />
                                    </IconButton>
                                  )}
                                  <Menu open={menuFor === menuKey} onClose={closeMenu} anchor={menuAnchor} label={`Actions for ${p.name}`}>
                                    <ConfirmButton
                                      role="menuitem"
                                      className="kos-menu-row is-danger"
                                      label="Delete project"
                                      confirmLabel="Delete for good"
                                      text={`Delete ${p.name}? Its chats, and what of it is in the trash, are kept; the rest goes.`}
                                      onConfirm={() => {
                                        setMenuFor(null);
                                        void onDeleteProject!(p.slug).catch(() => undefined);
                                      }}
                                    />
                                  </Menu>
                                  <a
                                    className={`chats-item ${p.thread?.id === activeId ? "is-active" : ""}`}
                                    href={hrefFor({ name: "project", slug: p.slug })}
                                    title={p.type}
                                    aria-label={p.name}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      onOpenProject(p.slug);
                                    }}
                                  >
                                    {p.thread?.id === activeId && (
                                      <m.span className="chats-active-bar" layoutId="chat-active" transition={spring} />
                                    )}
                                    <span className="chats-item-top">
                                      <span className="chats-lead">
                                        <ProjectMark slug={p.slug} name={p.name} colour={p.colour} />
                                      </span>
                                      <span className="chats-item-title">{p.name}</span>
                                      {p.busy && <StatusDot state="working" label="working" />}
                                    </span>
                                  </a>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </RailGroup>
                  )}

                  {/* Threads a schedule runs in. Above the chats rather than under
                      them, so reaching one does not mean scrolling past every
                      chat. Open until folded: shut, it read as no way in. */}
                  {scheduled.length > 0 && (
                    <RailGroup
                      title="Schedules"
                      count={scheduled.length}
                      {...(runningJobs > 0 ? { note: `${runningJobs} running` } : {})}
                      // Open on the thread being read, whatever was folded: its row is where the reader is.
                      open={q !== "" || folds.isOpen("scheduled") || scheduled.some((c) => c.id === activeId)}
                      {...(q ? {} : { onToggle: () => folds.toggle("scheduled") })}
                    >
                      <ul className="chats-jobs">
                        {scheduled.map((c) => (
                          <li key={c.id}>
                            <a
                              className={`chats-item chats-item--job ${c.id === activeId ? "is-active" : ""}`}
                              href={hrefFor({ name: "chats", id: c.id })}
                              onClick={(e) => {
                                e.preventDefault();
                                onOpen(c.id);
                              }}
                            >
                              {c.id === activeId && <m.span className="chats-active-bar" layoutId="chat-active" transition={spring} />}
                              <span className="chats-item-top">
                                <span className="chats-lead">
                                  <ThreadDot live={progress[c.id]} chat={c} waiting={waitingOn.has(c.id)} />
                                </span>
                                <span className="chats-item-title">{c.title}</span>
                                <QueuedMark n={c.queued} />
                                <span className="chats-item-when"><When at={c.updatedAt} /></span>
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </RailGroup>
                  )}

                  {(!q || filtered.length > 0) && (
                    <RailGroup
                      title="Chats"
                      count={filtered.length}
                      open={q !== "" || folds.isOpen("chats")}
                      {...(q ? {} : { onToggle: () => folds.toggle("chats") })}
                    >
                      <ul className="chats-flat">
                        {filtered.map((c) => renderChat(c))}
                        {filtered.length === 0 && (
                          <li><EmptyState variant="inline" loading={loading} className="chats-empty">No direct chats. Type on the landing, or let KOS route work to a project.</EmptyState></li>
                        )}
                      </ul>
                    </RailGroup>
                  )}

                  {q && !shownKos && shownSurfaces.length === 0 && shownProjects.length === 0 && scheduled.length === 0 && filtered.length === 0 && (
                    <EmptyState variant="inline" className="chats-empty" query={{ noun: "chats", onClear: () => setQuery("") }} />
                  )}
                </>
              )}
            </div>

            {/* The places you go now and then, at the foot and staying there
                while the rail scrolls: where KOS repairs itself, and the
                archive. Neither is a filter on the list you are reading. */}
            <div className="chats-foot">
              {!showArchived &&
                systemProjects.map((p) => (
                  <a
                    key={p.slug}
                    className="chats-foot-btn"
                    href={hrefFor({ name: "project", slug: p.slug })}
                    title="Where KOS repairs itself"
                    onClick={(e) => {
                      e.preventDefault();
                      onOpenProject(p.slug);
                    }}
                  >
                    <WrenchIcon />
                    {p.name}
                    {p.busy && <StatusDot state="working" label="working" />}
                  </a>
                ))}
              <button
                type="button"
                className={`chats-foot-btn ${showArchived ? "is-on" : ""}`}
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? <ChevronLeft size={14} /> : <ArchiveIcon />}
                {showArchived ? "Back to chats" : "Archived"}
              </button>
            </div>
          </aside>
        )}

        <section className={`chats-view${inline ? " has-inline" : ""}`}>
          {inline && (
            <div className="chats-inline" ref={inlineScroll}>
              <ArtifactViewer
                ref={viewer}
                id={inline}
                projects={projects}
                backTo="the chat"
                onBack={() => setInline(undefined)}
                onOpenChat={(owner) => {
                  // The thread the request went to: the project's, the blob's, or KOS at the root.
                  setInline(undefined);
                  const id = chatIdOf(owner);
                  if (id) onOpen(id);
                  // Not named (the settings did not load): the chat list, which is what shows once the artifact closes.
                  else void rootChatId().then(onOpen, () => undefined);
                }}
              />
            </div>
          )}
          <Toast
            note={
              undo && {
                kind: "ok",
                text: `Archived “${undo.title}”.`,
                undo: () => {
                  const back = undo;
                  setUndo(null);
                  void api.archiveConversation(back.id, false).then(() => {
                    onChanged();
                    if (back.reopen) onOpen(back.id);
                  });
                },
              }
            }
          />
          {/* Renaming is the one thing about a chat an owner changes most,
              and it was reachable only by knowing to type /rename. */}
          <Modal
            open={renaming !== null}
            title="Rename chat"
            size="sm"
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
              <Field label="Title">
                <input
                  className="kos-input"
                  autoFocus
                  value={renaming?.title ?? ""}
                  onChange={(e) =>
                    setRenaming((r) => (r ? { ...r, title: e.target.value } : r))
                  }
                />
              </Field>
              <SheetFoot
                inline
                onCancel={() => setRenaming(null)}
                primary={
                  <button type="submit" className="btn btn--primary" disabled={!renaming?.title.trim()}>
                    Save
                  </button>
                }
              />
            </form>
          </Modal>
          {!active && loading && (activeId || project || agent) ? (
            <>
              <div className="chats-view-path">{listToggle}</div>
              <div className="chats-placeholder">
                <EmptyState loading className="chats-loading" />
              </div>
            </>
          ) : !active && stray === "gone" ? (
            <>
              <div className="chats-view-path">{listToggle}</div>
              <NotFound what="chat" name={activeId!} back={{ label: "Back to Chats", href: hrefFor({ name: "chats" }) }} />
            </>
          ) : !active && (project || agent) ? (
            /* Inside a project there is no landing: the thread is the
               orchestrator's by default, and it is being stood up if it is not
               there yet. Inside an agent, likewise its own thread. */
            <>
              <div className="chats-view-path">{listToggle}</div>
              <div className="chats-placeholder">
                <p className="ops-muted">
                  {agent
                    ? `No thread for a blob called ${agent.name} yet.`
                    : !projectRecord
                      ? `No project called ${project!.slug}.`
                      : needsOrchestrator
                        ? "Starting the orchestrator…"
                        : "No such thread in this project."}
                </p>
              </div>
            </>
          ) : !active ? (
            <>
            {/* The toggle is here too: with the list folded and no chat open
                there was no button to bring it back. */}
            <div className="chats-view-path">{listToggle}</div>
            <div className="chats-placeholder">
              {/* Opening KOS lands here. It used to say "pick a chat"; a front
                  door should offer the way in. */}
              <m.div
                className="chats-welcome"
                variants={stagger}
                initial="hidden"
                animate="show"
              >
                <m.span className="chats-welcome-glyph" variants={card}>
                  <Face seed={KOS_SEED} look={faceLookOf(kos)} size={56} mood={moodOf(orchestrator?.activity)} label="KOS" />
                </m.span>
                <m.div className="chats-welcome-head" variants={card}>
                  <h1 className="chats-welcome-title" tabIndex={-1}>{LANDING_WORDS[mode].title}</h1>
                  <p className="chats-welcome-sub">{LANDING_WORDS[mode].sub}</p>
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
                  <SecretOffer draft={opening} onDraft={setOpening} />
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
                        const form = e.currentTarget.form;
                        composerKeyDown(e, () => form?.requestSubmit());
                      }}
                    />
                    <div className="chats-welcome-actions">
                      <Chips
                        small
                        round
                        label="What to create"
                        selected={mode}
                        options={[
                          ["kos", "Ask KOS", "KOS answers, and starts a chat or a project if it needs one"],
                          ["chat", "New chat", "Opens a chat of its own with these words"],
                          ["project", "New project", "Makes a project, and its chat, from this description"],
                        ]}
                        onChoose={setMode}
                      />
                      <button
                        type="submit"
                        className="btn btn--primary btn--capsule"
                        disabled={creating || !opening.trim()}
                      >
                        {creating
                          ? "Opening…"
                          : mode === "project"
                            ? "Create"
                            : mode === "chat"
                              ? "Start"
                              : "Send"}
                      </button>
                    </div>
                  </div>
                </m.form>
                {tree.roots.length > 0 && (
                  <m.div className="chats-welcome-recent" variants={card}>
                    <span className="label">Recent</span>
                    <ul>
                      {tree.roots.slice(0, 5).map((c) => (
                        <li key={c.id}>
                          <RefChip kind="chat" onClick={() => onOpen(c.id)}>
                            {c.title}
                          </RefChip>
                        </li>
                      ))}
                    </ul>
                  </m.div>
                )}
              </m.div>
            </div>
            </>
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
                    {listToggle}
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
                  <h1 tabIndex={-1}>
                    {active.role && <Face seed={active.role} size={30} mood={moodOf(active.activity)} label="" />}
                    {active.kind === "orchestrator" && <Face seed={KOS_SEED} look={faceLookOf(kos)} size={30} mood={moodOf(active.activity)} label="" />}
                    {active.title}
                    {active.kind === "project" && <span className="chats-role"><span className="sr-only">, </span>Orchestrator</span>}
                    {(active.kind === "agent" || active.role) && <span className="chats-role"><span className="sr-only">, </span>Blob</span>}
                  </h1>
                  {/* Inside the project the rail lists the agents, so the count
                      would say what is already in view. */}
                  {active.kind === "project" && !project && (
                    <p className="chats-lineage">
                      {projectSummary(tree.byProject.get(active.projectSlug ?? "") ?? [])}
                    </p>
                  )}
                  {(() => {
                    const line = chatLine(active, projects);
                    return line ? <p className="chats-brief">{line}</p> : null;
                  })()}
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
                  {(project || agent) && (
                    /* An icon, not words: beside Configure and Archive a third
                       label squeezed the title into two lines. */
                    <IconButton
                      className={`chats-panel-toggle ${panelShown ? "is-on" : ""}`}
                      aria-pressed={panelShown}
                      label={panelShown ? "Hide the workspace panel" : "Show the workspace panel"}
                      title={panelShown ? "Hide files, pages and tables" : "Show files, pages and tables"}
                      onClick={togglePanel}
                    >
                      <PanelIcon on={panelShown} />
                    </IconButton>
                  )}
                  <button
                    type="button"
                    className="head-act"
                    onClick={() => setEditing((v) => !v)}
                  >
                    <GearIcon />
                    <span className="head-act-label">{editing ? "Close" : "Configure"}</span>
                  </button>
                  {/* KOS's own thread and Maintenance are KOS's: neither is archived. */}
                  {active.kind !== "orchestrator" && !(active.kind === "project" && projects.find((p) => p.slug === active.projectSlug)?.type === "system") && (
                    <button
                      type="button"
                      className="head-act"
                      onClick={() => {
                        const was = { id: active.id, title: active.title, reopen: true };
                        void api.archiveConversation(active.id).then(() => {
                          onChanged();
                          setUndo(was);
                          window.location.hash = "#/";
                        });
                      }}
                    >
                      <ArchiveIcon />
                      <span className="head-act-label">Archive</span>
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

              {/* Handing a chat on: KOS drafts the brief, the owner sends it
                  to a chat or project, which runs with it. The door the agent
                  used to find through the sql tool, as a menu item. */}
              <Modal open={handingOff !== null} title={handingOff ? `Hand off “${handingOff.title}”` : "Hand off"} onClose={() => setHandingOff(null)}>
                {handingOff && (
                  <HandoffForm
                    key={handingOff.id}
                    from={handingOff}
                    projects={projects}
                    conversations={conversations}
                    onClose={() => setHandingOff(null)}
                    onDone={() => {
                      setHandingOff(null);
                      onChanged();
                    }}
                  />
                )}
              </Modal>

              {/* The thread knows the chats and agents by name, so a chip can
                  read "Lane A" rather than the id it is addressed by. */}
              <MentionNames resolve={nameFor} hrefOf={channelHref}>
              {/* Its step pictures open in the Lightbox, the turn's others a step away. */}
              <PictureGallery>
              <div className="chats-thread" ref={threadScroll} role="log" aria-live="polite" aria-relevant="additions" aria-busy={live !== undefined || sendingIn === activeId} aria-label={`Messages with ${threadWho}`}>
                {cut.earlier > 0 && <EarlierButton count={cut.earlier} scroller={boxRef} onShow={showEarlier} />}
                {visible.length === 0 && <EmptyState variant="inline">Nothing said yet.</EmptyState>}
                {(() => {
                  // Owner turns are numbered in order, because rewind addresses
                  // them by position rather than by any id a transcript keeps;
                  // counted as KOS holds them, from the last line the chat was
                  // set aside under. Those above it are kept for the owner to
                  // read, not to change.
                  let lastLine = -1;
                  visible.forEach((e, i) => {
                    if (e.kind === "divider") lastLine = i;
                  });
                  let owner = lastLine >= 0 ? -1 : cut.ownerAbove - 1;
                  // The latest time said so far, to tell a message sent before the ones above it.
                  let lastAt: number | undefined;
                  return visible.map((e, i) => {
                    const turn = e.kind === "message" && e.role === "you" && i > lastLine ? ++owner : -1;
                    const mark = marks[i];
                    const before = lastAt;
                    if (e.kind === "message" && e.at) lastAt = Math.max(lastAt ?? 0, e.at);
                    return (
                      <Fragment key={i}>
                        {mark && <TimeLine mark={mark} />}
                        {renderEvent(e, i, turn, before)}
                      </Fragment>
                    );
                  });
                })()}
                {/* Said somewhere else (Discord, a phone, another tab): the
                    words show now, as they would had they been typed here,
                    rather than when the turn ends. This tab's own message is
                    already in the list above. */}
                {live && liveSaid && (
                  <>
                    {liveMark && <TimeLine mark={liveMark} />}
                    <Timed className="turn turn--you">
                      <div className="turn-said">
                        {/* A turn found running when the page loaded began at a time this page never saw. */}
                        {live.resumed ? null : <MessageTime at={live.since} />}
                        <div className="bubble bubble--you">
                          <Markdown text={liveSaid} />
                        </div>
                      </div>
                      {live.origin ? <OriginLine origin={live.origin} linkFor={roomLink} /> : live.from && live.from !== "dashboard" && <span className="turn-via">via {live.from}</span>}
                      {live.files && live.files.length > 0 && <AttachmentStrip items={live.files} />}
                    </Timed>
                  </>
                )}
                {/* No BlockActions round a running turn: its steps carry the owner's own words too, and
                    KOS's blocks offer Send once the reply is in the thread. */}
                {live ? (
                  <LiveTurn
                    live={live}
                    waiting={activeId !== undefined && (waitingOn.has(activeId) || active?.activity === "needs-you")}
                  />
                ) : (
                  sendingIn === activeId && (
                    // The same markup a running turn uses, not a lookalike:
                    // built separately it picked up the bubble's font size and
                    // colour and read as a different kind of thing.
                    <div className="bubble bubble--kos live">
                      <div className="live-head">
                        <WorkingDots />
                        <span className="live-what">Sending</span>
                      </div>
                    </div>
                  )
                )}

                {/* A build this conversation started. It runs somewhere else and
                    for minutes, so the chat says it exists and links to it
                    rather than going quiet and leaving the reader to find the
                    Blobs page on their own. */}
                {mine.map((b) => (
                  <button
                    type="button"
                    className={`chat-agent chat-agent--${b.status}`}
                    key={b.id}
                    onClick={() => onOpenAgent(b.id)}
                  >
                    <StatusDot state={buildDot(b.status)} label={b.status} />
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
                    layout="position"
                    variants={rise}
                    initial="hidden"
                    animate="show"
                    exit="exit"
                    transition={ease}
                  >
                    <PendingAsk ask={a} deciding={deciding} onDecide={(id, ok, remember, code) => (code !== undefined ? onDecide(String(id), ok, false, code) : remember ? onDecide(String(id), ok, true) : onDecide(String(id), ok))} />
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
                    <IconButton
                      className="note-close"
                      label="Dismiss"
                      onClick={() =>
                        setNotes((all) => all.filter((x) => x.id !== n.id))
                      }
                    >
                      <CloseIcon size={12} title="" />
                    </IconButton>
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
                {/* A queued message whose turn has just begun is already on
                    the screen as the live turn's own words; shown here too it
                    would read twice until the next fetch. */}
                {waitingRows(pending, live).map((p) => (
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
                          <span className="label queued-mark">queued</span>
                        </div>
                        {/* Where it came from, as it will read once sent: a
                            message waiting from Discord is one here too. */}
                        {p.origin && <OriginLine origin={p.origin} linkFor={roomLink} />}
                        {/* What came with it, by name: the files are kept when the turn runs. */}
                        {p.attachments.length > 0 && <AttachmentStrip items={p.attachments} />}
                        <div className="queued-actions">
                          <IconButton

                            label="Edit before it runs"
                            onClick={() => setEditingQueued({ id: p.id, text: p.text })}
                          >
                            <EditIcon />
                          </IconButton>
                          <IconButton

                            label="Copy"
                            onClick={() => void navigator.clipboard.writeText(p.text)}
                          >
                            <CopyIcon />
                          </IconButton>
                          <IconButton

                            label="Ask this in a copy of the chat instead"
                            onClick={() => void forkQueued(p.id)}
                          >
                            <ForkIcon />
                          </IconButton>
                          <IconButton tone="danger"

                            label="Drop it before it runs"
                            onClick={() => void dropQueued(p.id)}
                          >
                            {/* Drawn like the others. A text cross sat on a
                                different baseline and at a different weight
                                from the icons beside it. */}
                            <CloseIcon size={15} title="" />
                          </IconButton>
                        </div>
                      </>
                    )}
                  </m.div>
                ))}
                {/* Sent here mid-turn and not yet a row on the server: under the
                    turn, waiting, until the turn takes it in. */}
                {activeId !== undefined &&
                  waitingAsides(asides, activeId, live).map((a) => (
                    <m.div className="queued" key={`aside-${a.key}`} layout variants={listItem} initial="hidden" animate="show" exit="exit" transition={ease}>
                      <div className="bubble bubble--you is-queued">
                        {a.text}
                        <span className="label queued-mark">queued</span>
                      </div>
                      {a.attachments.length > 0 && <AttachmentStrip items={a.attachments} />}
                    </m.div>
                  ))}
                </AnimatePresence>
              </div>
              </PictureGallery>
              </MentionNames>
              {/* Outside the log, so showing it is not read as a new message. */}
              {away && <JumpToLatest scroller={boxRef} onJumped={() => inputRef.current?.focus({ preventScroll: true })} />}

              <div
                className={`chats-composer composer ${drop.over ? "is-over" : ""}`}
                {...drop.handlers}
              >
                <div className="composer-box">
                <AttachmentStrip
                  items={attachments.files.map((f) => ({
                    name: f.name,
                    ...(f.mediaType.startsWith("image/")
                      ? { src: `data:${f.mediaType};base64,${f.data}` }
                      : {}),
                  }))}
                  onRemove={attachments.remove}
                />
                <SecretOffer draft={draft} onDraft={setDraft} />
                <div className="composer-input">
                  <AutocompleteMenu
                    suggestions={suggestions}
                    cursor={acCursor}
                    onPick={choose}
                  />
                  <HighlightedInput value={draft} textareaRef={inputRef} channels={channelNames}>
                  <textarea
                    className="hl-area"
                    ref={inputRef}
                    // Where the focus goes after the last ask here is decided from the keyboard.
                    data-after-ask=""
                    aria-label={`Message ${active.title}`}
                    rows={1}
                    value={draft}
                    // On a narrow window the hints ran out of the box: who it goes to is the part to keep.
                    placeholder={
                      reach.down
                        ? "KOS is not answering, retrying"
                        : narrow
                          ? `Message ${clipped(active.title, 20)}`
                          : `Message ${clipped(active.title, 32)}, / for commands, @ to name things`
                    }
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
                      // An input method's keys (a candidate picked with Enter, its list walked with the arrows) are its own.
                      if (suggestions.length > 0 && !e.nativeEvent.isComposing) {
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
                  <ModeChip mode={chatMode} onChange={setChatMode} running={running} />
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
                      className="send send--stop"
                      aria-label={stopping ? "Stopping" : "Stop"}
                      title="Stop (Cmd+Enter)"
                      disabled={stopping}
                      onClick={stop}
                    >
                      <StopIcon />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="send"
                      aria-label="Send"
                      title="Send (Enter)"
                      onClick={() => void send()}
                      disabled={reach.down || (draft.trim() === "" && attachments.files.length === 0)}
                    >
                      <SendIcon />
                    </button>
                  )}
                </div>
                </div>
              </div>
            </>
          )}
          {(project || agent) && <ArtifactStrip {...railProps} />}
        </section>

        {(project || agent) && drawer.open && <div className="chats-panel-backdrop" aria-hidden="true" onClick={drawer.close} />}
        {project && (
          /* Mounted while hidden, so hiding is the column sliding shut rather
             than the panel vanishing; it polls nothing until it is back. */
          <ProjectPanel
            slug={project.slug}
            rail={<ArtifactRail {...railProps} />}
            onOpenFile={project.onOpenFile}
            onAskAboutFiles={askAboutFiles}
            onChanged={onChanged}
            onError={project.onError}
            hidden={!panelShown}
            modal={drawer.open}
            onClose={drawer.close}
          />
        )}
        {agent && (
          <AgentPanel
            name={agent.name}
            onOpenFile={agent.onOpenFile}
            onAskAboutFiles={askAboutFiles}
            onChanged={onChanged}
            onError={agent.onError}
            onNotice={onNotice}
            onRemoved={agent.onRemoved}
            hidden={!panelShown}
            modal={drawer.open}
            onClose={drawer.close}
            rail={<ArtifactRail {...railProps} />}
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
        {(project || agent) && !narrow && (
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
              if (panelOpen) rememberPanel();
            }}
            onExpand={() => {
              if (!panelOpen) rememberPanel();
            }}
          />
        )}
      </div>
    </ArtifactOpen.Provider>
  );
}

/** A draggable column: where its width is kept, its bounds, and where it starts. */
interface ColumnSpec {
  key: string;
  min: number;
  max: number;
  fallback: number;
}
/** How long a turn the stream announced is believed over a list that still says idle: three polls. */
const FRESH_TURN_MS = 15_000;
/** Events of a chat read at a time: a long chat opens on its newest, the rest a Show earlier away. */
const CHAT_WINDOW = 200;

const RAIL_W: ColumnSpec = { key: "kos.chats.rail", min: 120, max: 420, fallback: 240 };
const PANEL_W: ColumnSpec = { key: "kos.project.panel.w", min: 160, max: 640, fallback: 300 };
/** A project's schedule, as a row under its agents: a height rather than a width. */
const SCHED_H: ColumnSpec = { key: "kos.project.schedule.h", min: 64, max: 480, fallback: 160 };
const SCHED_SHUT_KEY = "kos.project.schedule.shut";
/**
 * The rail sections that start folded. None: the schedules folded shut read
 * as no way to reach a schedule's thread at all.
 */
const SHUT_BY_DEFAULT: readonly string[] = [];

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
