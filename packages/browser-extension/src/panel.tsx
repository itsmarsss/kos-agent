import { CHAT_COMMANDS, KOS_SEED } from "@kos/shared";
import type { BlobMood } from "@kos/shared/blobmotion";
import { AskSteps, BoltIcon, ChevronDown, Chips, Collapse, ComposeIcon, Countdown, ease, Elapsed, Face, GlobeIcon, HandIcon, IconButton, Markdown, PageIcon, Pill, QuoteLine, SendIcon, spring, StepPicture, StepsIcon, StopIcon, type Tone, useDismiss, useOverlayScroll, WorkingDots } from "@kos/kit";
import { AnimatePresence, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { createRoot } from "react-dom/client";

import { frameOf, keep, pictureSrc, picturesOf, showable, type Pictured } from "./frames.js";
import { linkWords } from "./linkwords.js";
import { isHidden } from "./settings.js";
import { ask, minutesLeft, minutesWords } from "./pages.js";
import type { ConsentRequest, KosState, PopupState } from "./worker.js";

/**
 * The side panel: a chat with KOS beside the owner's tabs. It shows the
 * chat as KOS keeps it, the steps of the turn running now, approvals, asks
 * to work in this tab and to read pages, all answered in place, and the tab
 * beside it, with what KOS may do there. The chat can be switched to
 * another and the model chosen, as on the dashboard. Nothing waits forever:
 * a KOS that never shows the chat, or never takes the owner's words, is
 * said to, and the words come back to be sent again.
 */

/** What the owner quoted with their words, and where from: a page's address once sent, its site while selected. */
interface Quote {
  text: string;
  from: string;
}

type Line =
  | { role: "you"; text: string; files?: string[]; quote?: Quote }
  | { role: "kos"; text: string }
  | { role: "note"; text: string }
  | { role: "steps"; steps: Step[] };

/** A step of a turn, with the frame id of what it saw when it kept a picture. */
interface Step {
  summary: string;
  failed?: true;
  frame?: number;
}

interface Approval {
  id: string;
  tool: string;
  args?: string;
  /** Every action a step said by its purpose takes, which the arguments, cut to fit, may not reach. */
  mechanics?: string;
  why?: string;
  reason?: string;
  /** What a remembered yes covers, as its button says it ("Always on shop.example"), when it can be remembered. */
  always?: string;
  /** When it lapses if nobody decides, epoch ms. */
  expiresAt?: number;
}

/** Something said in the chat's run that is not in its words, kept after the exchange it came in. */
interface Extra {
  after: number;
  text: string;
  /** The owner's words it is about, when KOS says: it goes under them, wherever they are. */
  said?: string;
  from?: string;
  /** A turn held on the owner: true until the chat moves on. */
  waiting?: true;
}

interface Chat {
  conversation: string | null;
  title: string;
  lines: Line[];
  /** The owner's words on their way, until the chat has them. */
  sending: string[];
  /** The story of each turn on the go, under the words it is about: one running, and one said meanwhile. */
  stories: Extra[];
  working: boolean;
  /** The words of the turn KOS last took, and when: a turn queued behind another starts its own clock. */
  taken?: { said: string; at: number };
  extras: Extra[];
  asks: Approval[];
  consent?: ConsentRequest;
  /** Words a failed turn never took, back for the owner to send again. */
  unsent?: string;
  /** This chat acts in the owner's Chrome without asking each step. */
  auto: boolean;
  /** The steps' pictures, by frame id: sent as each step ran, and with the chat as it stands. */
  pictures: Map<number, Pictured>;
  /** The pictures of each turn on the go, by the owner's words it is about. */
  live: { said?: string; frames: number[] }[];
  /** What KOS says the chat waits on: the owner allowing a session, or deciding an approval. */
  waiting?: "consent" | "approval";
  /** The owner has control of the chat's session: KOS waits for them to hand it back. */
  held: boolean;
}

/** A chat the panel may switch to. */
interface ChatItem {
  id: string;
  title: string;
  updatedAt: number;
}

/** What answers, and what it may be changed to; `fixed` names an engine that chooses its own. */
interface Models {
  current: string;
  choices: string[];
  fixed?: string;
}

/** Something an @ can name, as KOS's index answers it. */
interface Mention {
  kind: string;
  id: string;
  label: string;
  hint?: string;
}

/** An ask to let KOS read pages, waiting on the owner. */
interface ReadAsk {
  id: string;
  host: string;
}

const EMPTY: Chat = { conversation: null, title: "Chrome", lines: [], sending: [], working: false, extras: [], stories: [], asks: [], auto: false, pictures: new Map(), live: [], held: false };
/** How long a KOS has to show the chat once the panel opens, and to take the owner's words once sent. */
const SHOW_MS = 6_000;
const TAKE_MS = 12_000;
const STEP = "› ";
const yours = (lines: Line[]): number => lines.filter((l) => l.role === "you").length;

/** Where a quote is kept while its words are on their way: its chat and its words. */
const NO_QUOTE: Quote = { text: "", from: "" };

function quoteKey(conversation: string | null, said: string): string {
  return `${conversation ?? ""}\n${said}`;
}

function useChat(windowId: number | undefined, online: boolean): {
  chat: Chat;
  kos: string | null;
  error: string;
  /** This KOS never showed the chat: it has no side panel to talk to. */
  silent: boolean;
  chats: ChatItem[];
  models: Models | undefined;
  reads: ReadAsk[];
  /** What the owner has selected on the page beside the panel, as it is now, and the page's site. */
  selection: Quote;
  /** What an @ being typed can name, for the words typed after it. */
  mentions: { q: string; list: Mention[] };
  /** What each of the owner's messages on its way was sent about, by its words: shown above it until the chat has it. */
  quotes: Map<string, Quote>;
  /** The extension's state as it last said it: the session, and each KOS's line. */
  worker: PopupState | undefined;
  say: (message: Record<string, unknown>) => void;
  send: (text: string, selection?: Quote) => void;
  answer: (message: Record<string, unknown>) => void;
  answerRead: (id: string, granted: boolean) => void;
} {
  const [chat, setChat] = useState<Chat>(EMPTY);
  const [kos, setKos] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [shownOnce, setShownOnce] = useState(false);
  const [silent, setSilent] = useState(false);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [models, setModels] = useState<Models>();
  const [reads, setReads] = useState<ReadAsk[]>([]);
  const [selection, setSelection] = useState<Quote>(NO_QUOTE);
  const [mentions, setMentions] = useState<{ q: string; list: Mention[] }>({ q: "", list: [] });
  const [worker, setWorker] = useState<PopupState>();
  // What each message was said about, by chat and words: a Map, so no message text can be a key it already holds.
  const [quotes, setQuotes] = useState<Map<string, Quote>>(() => new Map());
  const quotedIn = useRef<string | null>(null);
  useEffect(() => {
    quotedIn.current = chat.conversation;
  }, [chat.conversation]);
  const port = useRef<chrome.runtime.Port | null>(null);
  const chosen = useRef<string | null>(null);
  const taking = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Heard from KOS since the words went: no need to wait on it any longer. */
  const heardBack = (): void => {
    clearTimeout(taking.current);
    taking.current = undefined;
  };
  // Words that went and were never taken come back, and the panel says why.
  const giveBack = (why: string): void => {
    heardBack();
    setError(why);
    setChat((c) => ({ ...c, working: false, stories: [], live: [], sending: [], ...(c.sending.length ? { unsent: c.sending.join("\n") } : {}) }));
  };

  useEffect(() => {
    if (windowId === undefined) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = (): void => {
      // Reloaded or updated, the extension leaves this page behind: its old
      // runtime connects to nothing again, so the page loads itself afresh.
      if (!chrome.runtime?.id) return location.reload();
      let p: chrome.runtime.Port;
      try {
        p = chrome.runtime.connect({ name: "panel" });
      } catch {
        return location.reload();
      }
      port.current = p;
      p.onMessage.addListener((message: Record<string, unknown>) => heard(message));
      // The worker sleeps and wakes; the panel finds it again.
      p.onDisconnect.addListener(() => {
        port.current = null;
        if (!stopped) retry = setTimeout(open, 600);
      });
      p.postMessage({ type: "hello", window: windowId, kos: chosen.current });
    };
    const heard = (message: Record<string, unknown>): void => {
      switch (message["type"]) {
        case "kos": {
          const id = (message["id"] as string | null) ?? null;
          // The same KOS found again after the worker slept: the chat stays as it was until it is drawn again.
          if (id === chosen.current && id !== null) return;
          chosen.current = id;
          setKos(id);
          setChat(EMPTY);
          setShownOnce(false);
          setSilent(false);
          setModels(undefined);
          return;
        }
        case "state":
          return setWorker(message["state"] as PopupState);
        case "chat.show":
          heardBack();
          setShownOnce(true);
          setSilent(false);
          return setChat((c) => shown(c, message));
        case "chat.status":
          return setChat((c) => {
            // Another chat's, from a turn the owner moved away from: not drawn over this one.
            if (!isShown(c, message)) return c;
            heardBack();
            if (typeof message["error"] === "string") setError(message["error"]);
            const s = stated(c, message);
            // A step's picture, on its own: the story it belongs to is told apart.
            if (message["frame"] !== undefined) return framed(s, message);
            if (message["taken"] === true) return took(s, message);
            // The state alone: what the chat waits on, and who holds it.
            if (!STATUS_WORDS.some((k) => k in message)) return s;
            return storied(s, message);
          });
        case "chat.chats":
          return setChats((message["chats"] as ChatItem[]) ?? []);
        case "chat.models":
          if (typeof message["error"] === "string") setError(`The model was not changed: ${message["error"]}`);
          return setModels(message["error"] ? undefined : { current: String(message["current"] ?? ""), choices: (message["choices"] as string[]) ?? [], ...(typeof message["fixed"] === "string" ? { fixed: message["fixed"] } : {}) });
        case "read.ask":
          return setReads((r) => [...r, { id: String(message["id"]), host: String(message["host"] ?? "") }]);
        case "read.done":
          return setReads((r) => r.filter((x) => x.id !== message["id"]));
        case "selection":
          return setSelection({ text: String(message["text"] ?? ""), from: String(message["from"] ?? "") });
        case "chat.mentions":
          return setMentions({ q: String(message["q"] ?? ""), list: (message["mentions"] as Mention[]) ?? [] });
        case "chat.ask": {
          const approval = message["approval"] as Approval;
          return setChat((c) => (isShown(c, message) ? { ...c, asks: [...c.asks.filter((a) => a.id !== approval.id), approval] } : c));
        }
        case "chat.settled":
          return setChat((c) => ({ ...c, asks: c.asks.filter((a) => a.id !== message["approval"]) }));
        case "consent":
          return setChat((c) => ({ ...c, consent: message["request"] as ConsentRequest }));
        case "consent.done":
          return setChat((c) => (c.consent?.id === message["id"] ? { ...c, consent: undefined } : c));
        case "error":
          return giveBack(String(message["message"] ?? ""));
        default:
          return;
      }
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      port.current?.disconnect();
    };
  }, [windowId]);

  // A KOS that is on and never shows the chat is one without a side panel to talk to.
  useEffect(() => {
    if (!online || !kos || shownOnce) return;
    const timer = setTimeout(() => setSilent(true), SHOW_MS);
    return () => clearTimeout(timer);
  }, [online, kos, shownOnce]);
  // What answers, asked for as soon as there is a KOS to ask, and again with each chat shown until it is known.
  useEffect(() => {
    if (online && kos && shownOnce && !models) port.current?.postMessage({ type: "models" });
  }, [online, kos, shownOnce, models, chat.conversation]);

  const say = useCallback((message: Record<string, unknown>) => {
    setError("");
    port.current?.postMessage(message);
  }, []);
  const send = useCallback(
    (text: string, about?: Quote) => {
      const said = text.trim();
      if (!said) return;
      if (about) setQuotes((q) => new Map(q).set(quoteKey(quotedIn.current, said), about));
      // A command (/new, /switch) is never in the chat's words, so it waits for nothing but its answer.
      // The turn already running keeps its story: these words go to it at its next step, or run after it.
      setChat((c) => ({ ...c, sending: said.startsWith("/") ? c.sending : [...c.sending, said], working: true, unsent: undefined }));
      clearTimeout(taking.current);
      taking.current = setTimeout(() => giveBack("KOS did not take that. It may be an older KOS without the side panel, or not reachable now; your words are back in the box."), TAKE_MS);
      say({ type: "send", text: said, ...(about ? { quote: { text: about.text } } : {}) });
    },
    [say],
  );
  const answerRead = useCallback(
    (id: string, granted: boolean) => {
      setReads((r) => r.filter((x) => x.id !== id));
      say({ type: "read.answer", id, granted });
    },
    [say],
  );
  /*
   * An approval or an ask to work here, answered: its card goes at once, and
   * a second press while it leaves says nothing, rather than asking KOS
   * about a decision already made.
   */
  const answered = useRef(new Set<string>());
  const answer = useCallback(
    (message: Record<string, unknown>) => {
      const id = String(message["approval"] ?? message["id"]);
      if (answered.current.has(id)) return;
      answered.current.add(id);
      setChat((c) => (message["type"] === "decide" ? { ...c, asks: c.asks.filter((a) => a.id !== id), working: message["approved"] === true } : { ...c, consent: undefined }));
      say(message);
    },
    [say],
  );
  return { chat, kos, error, silent, chats, models, reads, selection, mentions, quotes, worker, say, send, answer, answerRead };
}

/** What a status may say beyond the chat's state: one with none of these says the state alone. */
const STATUS_WORDS = ["said", "taken", "story", "error", "frame"];

/** Whether a call from KOS is about the chat shown: one it names as another chat is not. */
function isShown(c: Chat, message: Record<string, unknown>): boolean {
  const about = message["chat"];
  return typeof about !== "string" || c.conversation === null || about === c.conversation;
}

/** The chat's state as a status says it: what it waits on, and whether the owner holds it. A status without them clears them. */
function stated(c: Chat, message: Record<string, unknown>): Chat {
  const waiting = message["waiting"] === "consent" || message["waiting"] === "approval" ? message["waiting"] : undefined;
  return { ...c, waiting, held: message["held"] === true };
}

/** The chat as KOS says it stands now: the owner's words that arrived leave the waiting ones, and a finished turn's steps are in the chat itself. */
function shown(c: Chat, message: Record<string, unknown>): Chat {
  const conversation = (message["conversation"] as string | null) ?? null;
  const lines = (message["messages"] as Line[]) ?? [];
  const fresh = conversation !== c.conversation && c.conversation !== null;
  const said = lines.filter((l): l is Extract<Line, { role: "you" }> => l.role === "you").map((l) => l.text);
  const sending = fresh ? [] : c.sending.filter((t) => !said.includes(t));
  const notice = message["notice"] as { text: string; from?: string; waiting?: true; said?: string } | undefined;
  // A wait said before is over once the chat is shown again: decided, or still asked in its own card.
  const kept = fresh ? [] : c.extras.filter((x) => !x.waiting);
  const extras = [
    ...kept,
    ...(notice ? [{ after: yours(lines), text: notice.text, ...(notice.said ? { said: notice.said } : {}), ...(notice.from ? { from: notice.from } : {}), ...(notice.waiting ? { waiting: true as const } : {}) }] : []),
  ];
  const answered = !sending.length && (notice !== undefined || lines.at(-1)?.role !== "you");
  return {
    ...c,
    conversation,
    title: String(message["title"] ?? "Chrome"),
    auto: message["auto"] === true,
    lines,
    sending,
    extras,
    working: sending.length > 0 || (c.working && !answered),
    pictures: keep(fresh ? new Map() : c.pictures, picturesOf(message)),
    ...(answered ? { stories: [], live: [] } : {}),
    ...(fresh ? { asks: [] } : {}),
  };
}

/**
 * The owner's words, taken by KOS. Ones said somewhere else (on the
 * dashboard, in another Chrome) show here on their way, as if typed here,
 * and the turn on them is told as it goes.
 */
function took(c: Chat, message: Record<string, unknown>): Chat {
  const said = typeof message["said"] === "string" ? message["said"] : undefined;
  if (!said || message["conversation"] !== c.conversation) return c;
  const shown = c.sending.includes(said) || awaiting(c.lines, said);
  const taken = c.taken?.said === said ? c.taken : { said, at: Date.now() };
  return { ...c, sending: shown ? c.sending : [...c.sending, said], working: true, taken };
}

/** The owner's words are the chat's latest and not yet answered: the turn on them is in the chat already. */
function awaiting(lines: Line[], said: string): boolean {
  const words = lines.flatMap((l) => (l.role === "you" ? [l.text] : []));
  return words.at(-1) === said && answeredWith(lines, words.length) < 0;
}

function storied(c: Chat, message: Record<string, unknown>): Chat {
  const story = message["story"];
  const said = typeof message["said"] === "string" ? message["said"] : undefined;
  // A failed turn: what is still waiting was never taken, and goes back to the owner.
  if (typeof message["error"] === "string") return { ...c, working: false, stories: [], live: [], sending: [], ...(c.sending.length ? { unsent: c.sending.join("\n") } : {}) };
  if (typeof story !== "string") return { ...c, working: false };
  const after = anchorOf(c, said);
  // The steps a finished turn already shows, told once more as it closed: nothing new.
  if (!c.sending.length && answeredWith(c.lines, after) >= stepsIn(story)) return c;
  const next: Extra = { after, text: story, ...(said !== undefined ? { said } : {}) };
  const others = c.stories.filter((x) => (said !== undefined ? x.said !== said : x.after !== after));
  return { ...c, working: true, stories: [...others, next] };
}

/** A step's picture as the turn takes it: kept, and shown with the story of the words it is about. */
function framed(c: Chat, message: Record<string, unknown>): Chat {
  const frame = frameOf(message);
  if (!frame || message["conversation"] !== c.conversation) return c;
  const said = typeof message["said"] === "string" ? message["said"] : undefined;
  const at = c.live.findIndex((x) => x.said === said);
  const entry = at >= 0 ? c.live[at]! : { ...(said !== undefined ? { said } : {}), frames: [] };
  const next = { ...entry, frames: [...entry.frames.filter((id) => id !== frame[0]), frame[0]] };
  return { ...c, pictures: keep(c.pictures, [frame]), live: at >= 0 ? c.live.map((x, i) => (i === at ? next : x)) : [...c.live, next] };
}

/** The owner's words in order, said and on their way: what a story or a notice is placed under. */
const yourWords = (c: Pick<Chat, "lines" | "sending">): string[] => [...c.lines.flatMap((l) => (l.role === "you" ? [l.text] : [])), ...c.sending];

/** The exchange the owner's words began, counted from one; the latest exchange when they are not there. */
function anchorOf(c: Pick<Chat, "lines" | "sending">, said: string | undefined): number {
  const words = yourWords(c);
  const at = said !== undefined ? words.lastIndexOf(said) : -1;
  return at >= 0 ? at + 1 : words.length;
}

const stepsIn = (story: string): number => story.split("\n").filter((l) => l.startsWith(STEP)).length;

/** How many steps the exchange after the owner's n-th words shows, once KOS has answered it; -1 before. */
function answeredWith(lines: Line[], n: number): number {
  let seen = 0;
  let steps = 0;
  let answered = false;
  for (const line of lines) {
    if (line.role === "you") seen++;
    else if (seen === n && line.role === "steps") steps += line.steps.length;
    else if (seen === n && line.role === "kos") answered = true;
  }
  return answered && seen === n ? steps : -1;
}

/** The tab in front of this window, as it changes. */
function useTab(windowId: number | undefined): chrome.tabs.Tab | undefined {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  useEffect(() => {
    if (windowId === undefined) return;
    const look = (): void => void chrome.tabs.query({ active: true, windowId }).then(([t]) => setTab(t));
    look();
    const activated = (info: chrome.tabs.OnActivatedInfo): void => (info.windowId === windowId ? look() : undefined);
    const updated = (_id: number, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab): void => (t.active && t.windowId === windowId && (change.url || change.title || change.favIconUrl || change.status) ? setTab(t) : undefined);
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    return () => {
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
    };
  }, [windowId]);
  return tab;
}

/** Whether KOS may read pages in this Chrome: one grant for every site, asked for in the panel. */
function useReading(): { can: boolean; allow: () => void } {
  const [can, setCan] = useState(false);
  useEffect(() => {
    const check = (): void => void chrome.permissions.contains({ origins: ["<all_urls>"] }).then(setCan);
    check();
    chrome.permissions.onAdded.addListener(check);
    chrome.permissions.onRemoved.addListener(check);
    return () => {
      chrome.permissions.onAdded.removeListener(check);
      chrome.permissions.onRemoved.removeListener(check);
    };
  }, []);
  return { can, allow: () => void chrome.permissions.request({ origins: ["<all_urls>"] }).then(setCan) };
}

/** The extension's state: as the worker pushes it on each change to a session, and read now and then for the rest. */
function useWorkerState(pushed: PopupState | undefined): PopupState | undefined {
  const [state, setState] = useState<PopupState>();
  useEffect(() => {
    const read = (): void => void ask<PopupState>({ type: "state" }).then(setState, () => undefined);
    read();
    const timer = setInterval(read, 2_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (pushed) setState(pushed);
  }, [pushed]);
  return state;
}

function Panel(): ReactElement {
  const [windowId, setWindowId] = useState<number>();
  useEffect(() => void chrome.windows.getCurrent().then((w) => setWindowId(w.id)), []);
  const tab = useTab(windowId);
  const reading = useReading();
  const [kosId, setKosId] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const { chat, kos, error, silent, chats, models, reads, selection, mentions, quotes, worker, say, send, answer, answerRead } = useChat(windowId, online);
  const state = useWorkerState(worker);
  const k = state?.kos.find((x) => x.id === kosId);
  useEffect(() => setOnline(!!k && k.link === "online" && !k.held), [k]);
  // The chat's own session in this Chrome, whichever tab is beside the panel.
  const session = state?.session && chat.conversation !== null && state.session.conversation === chat.conversation ? state.session : undefined;
  const held = chat.held || session?.paused === true;
  // Something to stop: a turn running, a session at work, or an ask up for one.
  const busy = chat.working || chat.consent !== undefined || session !== undefined;
  const stop = (): void => say({ type: "stop" });
  useEffect(() => setKosId(kos), [kos]);
  const [switching, setSwitching] = useState(false);
  const titleRef = useRef<HTMLButtonElement>(null);
  const usable = online && !silent;
  const mood: BlobMood = !online ? "asleep" : chat.asks.length || chat.consent || reads.length || chat.waiting || held ? "needs-you" : chat.working ? "working" : "idle";
  return (
    <div className="panel">
      <header className="chat-head">
        <Face seed={KOS_SEED} size={30} mood={mood} drawing={k?.face} label="KOS" />
        <div className="head-text">
          <strong>KOS</strong>
          {usable ? (
            <button
              ref={titleRef}
              type="button"
              className="chat-title"
              aria-expanded={switching}
              title="Switch chat"
              onClick={() => {
                if (!switching) say({ type: "list" });
                setSwitching(!switching);
              }}
            >
              <span>{chat.conversation ? chat.title : "A chat beside your tabs"}</span>
              <m.span className="chev" animate={{ rotate: switching ? 180 : 0 }} transition={spring}>
                <ChevronDown size={11} title="" />
              </m.span>
            </button>
          ) : (
            <span className="sub" title={k ? linkWords(k).detail : undefined}>
              {!state?.kos.length ? "Not paired yet" : silent ? "This KOS cannot talk here yet" : k ? linkWords(k).word : "Connecting"}
            </span>
          )}
        </div>
        {state && state.kos.length > 1 && <KosPicker all={state.kos} chosen={kos} choose={(id) => say({ type: "kos", id })} />}
        {usable && (
          <IconButton label="New chat" onClick={() => send("/new")}>
            <ComposeIcon size={14} title="" />
          </IconButton>
        )}
        <AnimatePresence>
          {switching && usable && (
            <ChatSwitcher
              anchor={titleRef}
              chats={chats}
              current={chat.conversation}
              close={() => setSwitching(false)}
              pick={(id) => {
                setSwitching(false);
                if (id === null) send("/new");
                else if (id !== chat.conversation) say({ type: "switch", conversation: id });
              }}
            />
          )}
        </AnimatePresence>
      </header>
      <TabBar tab={tab} state={state} reading={reading} session={session} say={say} />
      {!state?.kos.length ? (
        <Unpaired />
      ) : silent ? (
        <Silent />
      ) : (
        <>
          <Pictures.Provider value={{ cache: chat.pictures, hidden: state?.settings.hiddenSites ?? [] }}>
            <Thread chat={chat} online={online} send={send} answer={answer} reads={reads} answerRead={answerRead} quotes={quotes} held={held} say={say} />
          </Pictures.Provider>
          <AnimatePresence>
            {error && (
              <m.p className="error panel-error" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={ease}>
                {error}
              </m.p>
            )}
          </AnimatePresence>
          <Composer
            online={online}
            k={k}
            send={send}
            busy={busy}
            stop={stop}
            unsent={chat.unsent}
            models={models}
            chooseModel={(model) => say({ type: "model", model })}
            auto={chat.auto}
            setAuto={(on) => say({ type: "auto", on })}
            selection={selection}
            mentions={mentions}
            askMentions={(q) => say({ type: "mentions", q })}
          />
        </>
      )}
    </div>
  );
}

function KosPicker({ all, chosen, choose }: { all: KosState[]; chosen: string | null; choose: (id: string) => void }): ReactElement {
  return (
    <select className="kos-picker" value={chosen ?? ""} aria-label="Which KOS" onChange={(e) => choose(e.target.value)}>
      {all.map((k) => (
        <option key={k.id} value={k.id}>
          {k.host}
        </option>
      ))}
    </select>
  );
}

/** The tab beside the panel: what it is, what KOS may do in it, and the chat's session with Take over, Hand back and Stop wherever it works. */
function TabBar({ tab, state, reading, session, say }: { tab: chrome.tabs.Tab | undefined; state: PopupState | undefined; reading: { can: boolean; allow: () => void }; session: PopupState["session"] | undefined; say: (m: Record<string, unknown>) => void }): ReactElement | null {
  if (!tab) return null;
  const url = tab.url ?? "";
  const web = /^https?:\/\//.test(url);
  const host = web ? new URL(url).host : "";
  const hidden = web && !!state && isHidden(url, state.settings.hiddenSites);
  const here = !!session;
  // The pill speaks of this tab: KOS at work in it, or the owner holding the chat's session wherever it is.
  const live = here && (session.paused || session.beside === tab.id);
  const pill: [string, Tone] = !web ? ["Not a web page", "muted"] : hidden ? ["Hidden from KOS", "muted"] : live ? [session.paused ? "You have it" : "KOS is working", session.paused ? "warn" : "accent"] : reading.can ? ["KOS can read", "ok"] : ["Not read", "muted"];
  return (
    <section className="tabbar" data-live={here || undefined}>
      <div className="line">
        <span className="tile tile--sm">{tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <GlobeIcon size={13} />}</span>
        <div className="line-text">
          <strong>{tab.title || host || "This tab"}</strong>
          <span>{here ? `${session.task} · ${minutesLeft(session.until)}` : host || url}</span>
        </div>
        <Pill tone={pill[1]}>{pill[0]}</Pill>
      </div>
      <Collapse open={here}>
        <div className="row">
          <button type="button" className="btn btn--sm" onClick={() => say({ type: session?.paused ? "handback" : "take" })}>
            {session?.paused ? "Hand back" : "Take over"}
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => say({ type: "stop" })}>
            Stop
          </button>
        </div>
      </Collapse>
      <Collapse open={web && !hidden && !reading.can}>
        <div className="row row--between">
          <span className="hint">Let KOS read the pages you ask it about. It reads one only when you ask, never a hidden site.</span>
          <button type="button" className="btn btn--sm btn--primary" onClick={reading.allow}>
            Allow
          </button>
        </div>
      </Collapse>
    </section>
  );
}

/** The chats this panel may continue, newest first, with a new one on top; a filter once there are many. */
function ChatSwitcher({ anchor, chats, current, pick, close }: { anchor: RefObject<HTMLButtonElement | null>; chats: ChatItem[]; current: string | null; pick: (id: string | null) => void; close: () => void }): ReactElement {
  const [q, setQ] = useState("");
  const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  const own = useRef<HTMLDivElement>(null);
  // Escape, or a press anywhere else, puts it away; the chat's name, which opens and shuts it, is its own.
  useDismiss(true, close, { inside: [own, anchor], scroll: false, resize: false });
  return (
    <m.div ref={own} className="switcher" initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={ease}>
      <button type="button" className="switcher-row switcher-new" onClick={() => pick(null)}>
        <ComposeIcon size={13} title="" />
        <span>New chat</span>
      </button>
      {chats.length > 8 && <input className="switcher-find" type="text" placeholder="Find a chat" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />}
      <div className="switcher-list">
        {!chats.length && <p className="hint switcher-empty">Loading your chats</p>}
        {shown.map((c) => (
          <button key={c.id} type="button" className="switcher-row" aria-current={c.id === current || undefined} onClick={() => pick(c.id)}>
            <span className="switcher-title">{c.title}</span>
            <span className="switcher-when">{when(c.updatedAt)}</span>
          </button>
        ))}
      </div>
    </m.div>
  );
}

/** A time as the chats list says it: now, minutes, hours, days. */
function when(at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (24 * 60))}d`;
}

/** A KOS that is on and never showed the chat: one from before the side panel. */
function Silent(): ReactElement {
  return (
    <div className="empty-state">
      <Face seed={KOS_SEED} size={56} mood="error" label="KOS" />
      <strong>This KOS cannot talk here yet</strong>
      <p className="hint">It is connected, but it does not answer the side panel. Update KOS, restart it, then reopen this panel. Its other work in this Chrome is not affected.</p>
    </div>
  );
}

function Unpaired(): ReactElement {
  return (
    <div className="empty-state">
      <Face seed={KOS_SEED} size={64} mood="asleep" label="KOS" />
      <strong>Pair this Chrome with KOS</strong>
      <p className="hint">Click the KOS icon in the toolbar and paste a pairing link from KOS: Settings, Devices, Add a device.</p>
    </div>
  );
}

const SUGGESTIONS = ["Summarize this page", "What should I know here?", "Find the important parts"];

/** The chat: each exchange, then what came with it, then what is waiting on the owner. */
function Thread({
  chat,
  online,
  send,
  answer,
  reads,
  answerRead,
  quotes,
  held,
  say,
}: {
  chat: Chat;
  online: boolean;
  send: (t: string) => void;
  answer: (m: Record<string, unknown>) => void;
  reads: ReadAsk[];
  answerRead: (id: string, granted: boolean) => void;
  /** What each of the owner's messages on its way was sent about, shown above it. */
  quotes: Map<string, Quote>;
  /** The owner has control of the chat's session. */
  held: boolean;
  say: (m: Record<string, unknown>) => void;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = useOverlayScroll(scroller);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  const empty = !chat.lines.length && !chat.sending.length && !chat.extras.length;
  const items: ReactNode[] = [];
  let seen = 0;
  // Each placed under the words it is about, where KOS said; otherwise after the exchange it came in.
  const words = yourWords(chat);
  const placed = (x: Extra): number => (x.said !== undefined && words.includes(x.said) ? words.lastIndexOf(x.said) + 1 : x.after);
  const after = (n: number): void => {
    chat.stories.forEach((x, i) => (placed(x) === n ? items.push(<Story key={`story${i}-${n}`} text={x.text} frames={chat.live.find((l) => l.said === x.said)?.frames ?? []} />) : undefined));
    chat.extras.forEach((x, i) => (placed(x) === n ? items.push(<Extra key={`x${i}`} extra={x} />) : undefined));
  };
  chat.lines.forEach((line, i) => {
    if (line.role === "you") {
      if (seen > 0 || i > 0) after(seen);
      seen++;
    }
    items.push(<LineView key={`l${i}`} line={line} />);
  });
  chat.sending.forEach((text, i) => {
    after(seen);
    seen++;
    const quoted = quotes.get(quoteKey(chat.conversation, text));
    items.push(<LineView key={`s${i}-${text.slice(0, 16)}`} line={{ role: "you", text, ...(quoted ? { quote: quoted } : {}) }} pending />);
  });
  after(seen);
  return (
    <div
      className="thread"
      ref={scroll}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {empty ? (
        <m.div className="empty-state" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={ease}>
          <p className="hint">Ask about this page, or have KOS do something in it. It asks before it works here.</p>
          {online && (
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="btn btn--sm" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </m.div>
      ) : (
        <AnimatePresence initial={false}>{items}</AnimatePresence>
      )}
      {/* At the foot for as long as the turn runs, whatever came last: words
          after the steps are not the end of the work. Gone the moment it ends,
          as the dashboard's is, not faded out over the answer. */}
      {held ? (
        <Held say={say} />
      ) : (
        (chat.working || chat.waiting) && <Working stories={chat.stories} since={chat.taken?.at} waiting={chat.waiting !== undefined || chat.asks.length > 0 || chat.consent !== undefined || reads.length > 0} />
      )}
      <AnimatePresence>
        {chat.asks.map((a) => (
          <AskCard key={`ask${a.id}`} approval={a} decide={(approved, remember) => answer({ type: "decide", approval: a.id, approved, ...(remember ? { remember: true } : {}) })} />
        ))}
        {chat.consent && <ConsentCard key={`consent${chat.consent.id}`} request={chat.consent} answer={(allowed, minutes, site) => answer({ type: "consent.answer", id: chat.consent!.id, allowed, minutes, ...(site ? { site: true } : {}) })} />}
        {reads.map((r) => (
          <ReadCard key={`read${r.id}`} ask={r} answer={(granted) => answerRead(r.id, granted)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

const enter = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0 }, transition: spring };

function LineView({ line, pending }: { line: Line; pending?: boolean }): ReactElement {
  switch (line.role) {
    case "you":
      return (
        <m.div className="msg msg--you" data-pending={pending || undefined} layout="position" {...enter}>
          {line.quote && <QuoteLine text={line.quote.text} from={line.quote.from} />}
          {line.text && <Markdown text={line.text} />}
          {line.files?.length ? (
            <div className="files">
              {line.files.map((f) => (
                <span key={f} className="file-chip">
                  <PageIcon size={11} />
                  {f}
                </span>
              ))}
            </div>
          ) : null}
        </m.div>
      );
    case "kos":
      return (
        <m.div className="msg msg--kos" layout="position" {...enter}>
          <Markdown text={line.text} />
        </m.div>
      );
    case "note":
      return (
        <m.p className="note" layout="position" {...enter}>
          {line.text}
        </m.p>
      );
    case "steps":
      return <Steps steps={line.steps} />;
  }
}

/** The pictures the chat holds, and the sites the owner hid here, whose pictures are never drawn. */
const Pictures = createContext<{ cache: ReadonlyMap<number, Pictured>; hidden: readonly string[] }>({ cache: new Map(), hidden: [] });

/** What the steps saw, each small under them and larger on a press, as on the dashboard; none from a hidden site. */
function StepPictures({ frames }: { frames: (number | undefined)[] }): ReactElement | null {
  const { cache, hidden } = useContext(Pictures);
  const shown = frames.flatMap((id) => {
    const p = id !== undefined ? cache.get(id) : undefined;
    return showable(p, hidden) ? [{ id: id!, p }] : [];
  });
  if (!shown.length) return null;
  return (
    <div className="step-pictures">
      {shown.map(({ id, p }) => (
        <StepPicture key={id} src={pictureSrc(p)} />
      ))}
    </div>
  );
}

/** The steps a turn took, folded to a count; open to read them. Under them, what they saw. */
function Steps({ steps, live, frames }: { steps: Step[]; live?: boolean; frames?: number[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((s) => s.failed).length;
  return (
    <m.div className="steps" data-live={live || undefined} layout="position" {...enter}>
      <button type="button" className="steps-head" aria-expanded={open || !!live} onClick={() => setOpen(!open)}>
        <StepsIcon size={12} />
        <span>
          {live ? `${steps.length > 1 ? `${steps.length}. ` : ""}${steps.at(-1)?.summary ?? "Working"}` : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
          {failed ? ` · ${failed} failed` : ""}
        </span>
        {!live && (
          <m.span className="chev" animate={{ rotate: open ? 180 : 0 }} transition={spring}>
            <ChevronDown size={11} title="" />
          </m.span>
        )}
      </button>
      <Collapse open={open && !live}>
        <ol className="steps-list">
          {steps.map((s, i) => (
            <li key={i} data-failed={s.failed || undefined}>
              {s.summary}
            </li>
          ))}
        </ol>
      </Collapse>
      <StepPictures frames={frames ?? steps.map((s) => s.frame)} />
    </m.div>
  );
}

/** What KOS is at, from the running story: its latest step while that is the last thing told, else working. */
function workingWhat(stories: Extra[]): string {
  const story = stories.at(-1);
  if (!story) return "Thinking";
  const last = story.text.split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return last.startsWith(STEP) && !last.endsWith(" (failed)") ? last.slice(STEP.length) : "Working";
}

/**
 * The running turn's foot, the dashboard's: the dots, what it is at, and for how long.
 * Counted from when its words were taken, or from when the foot came if that is later:
 * a take from a turn before this one is not when this one began.
 * Held on the owner, it says so, with no dots and no clock: the wait is theirs.
 */
function Working({ stories, since, waiting }: { stories: Extra[]; since: number | undefined; waiting: boolean }): ReactElement {
  const [shown] = useState(() => Date.now());
  return (
    <m.div className="working" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={ease}>
      {waiting ? (
        <span className="working-what">Waiting on you</span>
      ) : (
        <>
          <WorkingDots />
          <span className="working-what">{workingWhat(stories)}</span>
          <Elapsed since={Math.max(since ?? 0, shown)} />
        </>
      )}
    </m.div>
  );
}

/** The chat's session in the owner's hands: KOS waits for them, and they hand it back or stop it here. */
function Held({ say }: { say: (m: Record<string, unknown>) => void }): ReactElement {
  return (
    <m.div className="working working--held" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={ease}>
      <HandIcon size={12} />
      <span className="working-what">Paused, you have control</span>
      <button type="button" className="btn btn--sm" onClick={() => say({ type: "handback" })}>
        Hand back
      </button>
      <button type="button" className="btn btn--sm btn--danger" onClick={() => say({ type: "stop" })}>
        Stop
      </button>
    </m.div>
  );
}

/** The running turn: its steps so far, and what KOS is saying between them. */
function Story({ text, frames }: { text: string; frames: number[] }): ReactElement {
  // A long story comes as its tail, cut mid-line after a "…": that first line is a fragment.
  const lines = (text.startsWith("…") ? text.split("\n").slice(1) : text.split("\n")).filter((l) => l.trim());
  const steps = lines.filter((l) => l.startsWith(STEP)).map((l) => ({ summary: l.slice(STEP.length).replace(/ \(failed\)$/, ""), ...(l.endsWith(" (failed)") ? { failed: true as const } : {}) }));
  const words = lines.filter((l) => !l.startsWith(STEP)).join("\n");
  return (
    <>
      {steps.length > 0 && <Steps steps={steps} live frames={frames} />}
      {words && (
        <m.div className="msg msg--kos msg--live" layout="position" {...enter}>
          <Markdown text={words} />
        </m.div>
      )}
    </>
  );
}

function Extra({ extra }: { extra: Extra }): ReactElement {
  return (
    <m.div className="msg msg--kos" layout="position" {...enter}>
      {extra.from && <p className="from">{extra.from}</p>}
      <Markdown text={extra.text} />
    </m.div>
  );
}

/** An approval, as the dashboard's: what it would run, why, what it is asked for, and Approve, Always, Deny in that order. */
function AskCard({ approval, decide }: { approval: Approval; decide: (approved: boolean, remember?: boolean) => void }): ReactElement {
  return (
    <m.section className="card ask-card" layout {...enter}>
      <div className="ask-card-head">
        <p className="label">KOS asks to run</p>
        {approval.expiresAt !== undefined && <Countdown until={approval.expiresAt} />}
      </div>
      <strong className="mono">{approval.tool}</strong>
      <AskSteps mechanics={approval.mechanics} />
      {approval.why && <p className="hint">{approval.why}</p>}
      {approval.reason && <p className="hint ask-reason">Asked because it {approval.reason}.</p>}
      {approval.args && <pre className="args">{approval.args}</pre>}
      <div className="row">
        <button type="button" className="btn btn--primary" onClick={() => decide(true)}>
          Approve
        </button>
        {approval.always && (
          <button type="button" className="btn" title="Approve, and stop asking for this" onClick={() => decide(true, true)}>
            {approval.always}
          </button>
        )}
        <button type="button" className="btn" onClick={() => decide(false)}>
          Deny
        </button>
      </div>
    </m.section>
  );
}

/** KOS asked to read the page, and this Chrome has not let it read pages yet: the one press that can. */
function ReadCard({ ask: read, answer }: { ask: ReadAsk; answer: (granted: boolean) => void }): ReactElement {
  return (
    <m.section className="card ask-card ask-card--read" layout {...enter}>
      <p className="label">KOS wants to read this page</p>
      <strong>{read.host}</strong>
      <p className="hint">Chrome asks once whether KOS may read the pages you chat about. It reads one only when the chat asks, and never a site hidden from KOS.</p>
      <div className="row">
        <button type="button" className="btn" onClick={() => answer(false)}>
          Not now
        </button>
        <button
          type="button"
          className="btn btn--primary"
          autoFocus
          // Chrome grants this only from a press, so it is asked here and not by the worker.
          onClick={() => void chrome.permissions.request({ origins: ["<all_urls>"] }).then(answer, () => answer(false))}
        >
          Allow reading pages
        </button>
      </div>
    </m.section>
  );
}

/**
 * KOS asks to work in the tab beside the panel: for how long, and whether
 * its steps on this site may go unasked for this session, so the first one
 * is not a second prompt. Running script in a page and the other strict
 * tools ask either way.
 */
function ConsentCard({ request, answer }: { request: ConsentRequest; answer: (allowed: boolean, minutes: number, site: boolean) => void }): ReactElement {
  const [minutes, setMinutes] = useState(request.minutes);
  const [alone, setAlone] = useState(false);
  const choices = [...new Set([5, 15, 30, 60, 120].filter((v) => v <= Math.min(request.longest, Math.max(request.minutes, 5))).concat(request.minutes))].sort((a, b) => a - b);
  return (
    <m.section className="card ask-card ask-card--consent" layout {...enter}>
      <div className="ask-card-head">
        <p className="label">KOS wants to work in this tab</p>
        <Countdown until={request.expiresAt} />
      </div>
      <p className="quote">{request.task}</p>
      <Chips options={choices.map((v) => [v, minutesWords(v)])} selected={minutes} onChoose={setMinutes} />
      {request.site && (
        <label className="check">
          <input type="checkbox" checked={alone} onChange={(e) => setAlone(e.target.checked)} />
          <span>And act on {request.site} this session without asking</span>
        </label>
      )}
      <p className="hint">It works in the tab beside this panel, with a border on it. Click or type there to take over; Stop ends it.</p>
      <div className="row">
        <button type="button" className="btn btn--primary" autoFocus onClick={() => answer(true, minutes, alone)}>
          Allow
        </button>
        <button type="button" className="btn" onClick={() => answer(false, 0, false)}>
          Deny
        </button>
      </div>
    </m.section>
  );
}

function Composer({
  online,
  k,
  send,
  busy,
  stop,
  unsent,
  models,
  chooseModel,
  auto,
  setAuto,
  selection,
  mentions,
  askMentions,
}: {
  online: boolean;
  k: KosState | undefined;
  send: (t: string, selection?: Quote) => void;
  /** A turn, a session or an ask is on the go: the button is Stop. */
  busy: boolean;
  stop: () => void;
  unsent: string | undefined;
  models: Models | undefined;
  chooseModel: (model: string) => void;
  /** Whether this chat acts without asking. */
  auto: boolean;
  setAuto: (on: boolean) => void;
  /** What the owner has selected on the page, sent along unless they put it aside. */
  selection: Quote;
  mentions: { q: string; list: Mention[] };
  askMentions: (q: string) => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  /** The token the owner closed the menu on, so it stays closed until they type on. */
  const [closedAt, setClosedAt] = useState<string>();
  /** The selection the owner put aside, or sent: hidden until they select something else. */
  const [setAside, setSetAside] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const quoting = selection.text && selection.text !== setAside ? selection : undefined;
  const token = tokenAt(text, caret);
  const options = !token || token.raw === closedAt ? [] : token.kind === "command" ? commandsFor(token.q) : token.q === mentions.q ? mentions.list.map(mentionOption) : [];
  useEffect(() => {
    if (token?.kind !== "mention") return;
    const timer = setTimeout(() => askMentions(token.q), 120);
    return () => clearTimeout(timer);
  }, [token?.kind, token?.q]);
  useEffect(() => setPicked(0), [token?.raw]);
  useEffect(() => {
    if (unsent) setText((t) => t || unsent);
  }, [unsent]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  const go = (): void => {
    if (!online || !text.trim()) return;
    // A command is about the chat, not the page: it goes without the selection.
    const about = quoting && !text.trim().startsWith("/") ? quoting : undefined;
    send(text, about);
    if (about) setSetAside(about.text);
    setText("");
    setCaret(0);
  };
  /** What was picked in the menu, in place of the token typed. */
  const take = (option: Option): void => {
    if (!token) return;
    const next = `${text.slice(0, token.start)}${option.insert}${text.slice(caret)}`;
    const at = token.start + option.insert.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => box.current?.setSelectionRange(at, at));
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Cmd or Ctrl with Enter stops, as on the dashboard; Enter alone sends, which a running turn takes in.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (busy) stop();
      return;
    }
    if (options.length && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPicked((p) => (p + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        take(options[picked] ?? options[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setClosedAt(token?.raw);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      go();
    }
  };
  return (
    <div className="composer" data-off={!online || undefined}>
      <AnimatePresence>
        {options.length > 0 && (
          <m.ul className="ac-menu" role="listbox" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={ease}>
            {options.map((o, i) => (
              <li key={`${o.insert}-${i}`} role="option" aria-selected={i === picked} onMouseDown={(e) => (e.preventDefault(), take(o))} onMouseEnter={() => setPicked(i)}>
                <span className="ac-label">{o.label}</span>
                {o.hint && <span className="ac-hint">{o.hint}</span>}
              </li>
            ))}
          </m.ul>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {quoting && (
          <m.div className="composer-quote" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={ease}>
            <QuoteLine text={quoting.text} from={quoting.from} label="Selected text" lines={2} onRemove={() => setSetAside(quoting.text)} />
          </m.div>
        )}
      </AnimatePresence>
      <textarea
        ref={box}
        rows={1}
        value={text}
        placeholder={online ? (quoting ? "Ask about the selection" : "Message KOS, / for commands, @ to name things") : k?.held ? "Paused. Connect it from the KOS icon." : k ? `${linkWords(k).word}. See the KOS icon.` : "KOS is not connected"}
        disabled={!online}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setClosedAt(undefined);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={keys}
        autoFocus
      />
      <div className="composer-foot">
        <ModelChoice models={models} choose={chooseModel} />
        {online && <AutoChoice on={auto} set={setAuto} />}
        {busy && online ? (
          <m.button type="button" className="send send--stop" aria-label="Stop" title="Stop (Cmd+Enter)" onClick={stop} whileTap={{ scale: 0.97 }} transition={spring}>
            <StopIcon />
          </m.button>
        ) : (
          <m.button type="button" className="send" aria-label="Send" title="Send (Enter)" disabled={!online || !text.trim()} onClick={go} whileTap={{ scale: 0.97 }} transition={spring}>
            <SendIcon size={15} />
          </m.button>
        )}
      </div>
    </div>
  );
}

/** One line of the / or @ menu: what goes in the box, how it reads, and a word about it. */
interface Option {
  insert: string;
  label: string;
  hint?: string;
}

/** The token being typed at the caret: a command at the start of the box, or an @ after a space. */
function tokenAt(text: string, caret: number): { kind: "command" | "mention"; q: string; start: number; raw: string } | undefined {
  const before = text.slice(0, caret);
  const command = /^\/([a-z]*)$/.exec(before);
  if (command) return { kind: "command", q: command[1]!, start: 0, raw: before };
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) return { kind: "mention", q: mention[2]!, start: before.length - mention[2]!.length - 1, raw: `@${mention[2]!}` };
  return undefined;
}

/** The commands a surface can run, by the start of their names; the dashboard's own left out. */
function commandsFor(q: string): Option[] {
  return CHAT_COMMANDS.filter((c) => c.where !== "dashboard" && c.name.startsWith(q))
    .slice(0, 8)
    .map((c) => ({ insert: `/${c.name} `, label: `/${c.name}${c.args ? ` ${c.args}` : ""}`, hint: c.description }));
}

/** A thing to name, written as the dashboard writes it: plain when its id allows, in brackets when not. */
function mentionOption(mn: Mention): Option {
  const insert = mn.kind === "channel" ? `#${mn.id} ` : /^[A-Za-z0-9._/-]*[A-Za-z0-9_/-]$/.test(mn.id) ? `@${mn.kind}:${mn.id} ` : `@${mn.kind}:[${mn.id}] `;
  return { insert, label: mn.label, hint: mn.hint ?? mn.kind };
}

/**
 * Whether this chat asks before each step in the owner's Chrome, or acts on
 * its own: clicking, typing and going somewhere there. Running script in a
 * page, and anything outside the owner's Chrome, asks either way; the
 * border, Take over and Stop show either way.
 */
function AutoChoice({ on, set }: { on: boolean; set: (on: boolean) => void }): ReactElement {
  return (
    <m.button
      type="button"
      className="mode"
      data-on={on || undefined}
      aria-pressed={on}
      title={on ? "Auto: KOS clicks and types in your Chrome for this chat without asking. Scripts in a page, files and messages still ask. Press to ask each step again." : "Ask: KOS asks before each step in your Chrome. Press to let this chat act on its own."}
      onClick={() => set(!on)}
      whileTap={{ scale: 0.97 }}
      transition={spring}
    >
      {on ? <BoltIcon size={11} /> : <HandIcon size={11} />}
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span key={on ? "auto" : "ask"} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={ease}>
          {on ? "Auto" : "Ask"}
        </m.span>
      </AnimatePresence>
    </m.button>
  );
}

/**
 * The model KOS answers with, as the dashboard's picker sets it: for all of
 * KOS, not this chat alone. On an engine that chooses its own, it says which;
 * with nothing to choose between, it is not there.
 */
function ModelChoice({ models, choose }: { models: Models | undefined; choose: (model: string) => void }): ReactElement | null {
  if (models?.fixed) return <span className="model model--fixed" title="Answering on your Claude Code subscription; change it in KOS, Settings, Models">{models.fixed}</span>;
  if (!models?.current || !models.choices.length) return null;
  return (
    <label className="model" title="The model KOS answers with, everywhere, as the dashboard's picker sets it">
      <select value={models.current} aria-label="Model" onChange={(e) => choose(e.target.value)}>
        {models.choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <ChevronDown size={10} title="" />
    </label>
  );
}

createRoot(document.getElementById("root")!).render(
  <LazyMotion features={domMax} strict>
    <MotionConfig reducedMotion="user">
      <Panel />
    </MotionConfig>
  </LazyMotion>,
);
