import type { BlobMood } from "@kos/shared/blobmotion";
import { AnimatePresence, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { isHidden } from "./settings.js";
import { Markdown } from "./ui/markdown.js";
import { Chips, Collapse, Face, ICONS, Icon, Pill, ask, ease, minutesLeft, minutesWords, spring, type Tone } from "./ui/kit.js";
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

type Line =
  | { role: "you"; text: string; files?: string[] }
  | { role: "kos"; text: string }
  | { role: "note"; text: string }
  | { role: "steps"; steps: { summary: string; failed?: true }[] };

interface Approval {
  id: string;
  tool: string;
  args?: string;
  why?: string;
  reason?: string;
}

/** Something said in the chat's run that is not in its words, kept after the exchange it came in. */
interface Extra {
  after: number;
  text: string;
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
  /** The running turn's story, after the exchange it belongs to. */
  story?: Extra;
  working: boolean;
  extras: Extra[];
  asks: Approval[];
  consent?: ConsentRequest;
  /** Words a failed turn never took, back for the owner to send again. */
  unsent?: string;
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

/** An ask to let KOS read pages, waiting on the owner. */
interface ReadAsk {
  id: string;
  host: string;
}

const EMPTY: Chat = { conversation: null, title: "Chrome", lines: [], sending: [], working: false, extras: [], asks: [] };
/** How long a KOS has to show the chat once the panel opens, and to take the owner's words once sent. */
const SHOW_MS = 6_000;
const TAKE_MS = 12_000;
const STEP = "› ";
const yours = (lines: Line[]): number => lines.filter((l) => l.role === "you").length;

/** The line to the worker: the chat as it comes, and what the panel says back. */
function useChat(windowId: number | undefined, online: boolean): {
  chat: Chat;
  kos: string | null;
  error: string;
  /** This KOS never showed the chat: it has no side panel to talk to. */
  silent: boolean;
  chats: ChatItem[];
  models: Models | undefined;
  reads: ReadAsk[];
  say: (message: Record<string, unknown>) => void;
  send: (text: string) => void;
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
    setChat((c) => ({ ...c, working: false, story: undefined, sending: [], ...(c.sending.length ? { unsent: c.sending.join("\n") } : {}) }));
  };

  useEffect(() => {
    if (windowId === undefined) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = (): void => {
      const p = chrome.runtime.connect({ name: "panel" });
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
        case "kos":
          chosen.current = (message["id"] as string | null) ?? null;
          setKos(chosen.current);
          setChat(EMPTY);
          setShownOnce(false);
          setSilent(false);
          setModels(undefined);
          return;
        case "chat.show":
          heardBack();
          setShownOnce(true);
          setSilent(false);
          return setChat((c) => shown(c, message));
        case "chat.status":
          heardBack();
          if (typeof message["error"] === "string") setError(message["error"]);
          if (message["taken"] === true) return;
          return setChat((c) => storied(c, message));
        case "chat.chats":
          return setChats((message["chats"] as ChatItem[]) ?? []);
        case "chat.models":
          if (typeof message["error"] === "string") setError(`The model was not changed: ${message["error"]}`);
          return setModels(message["error"] ? undefined : { current: String(message["current"] ?? ""), choices: (message["choices"] as string[]) ?? [], ...(typeof message["fixed"] === "string" ? { fixed: message["fixed"] } : {}) });
        case "read.ask":
          return setReads((r) => [...r, { id: String(message["id"]), host: String(message["host"] ?? "") }]);
        case "read.done":
          return setReads((r) => r.filter((x) => x.id !== message["id"]));
        case "chat.ask": {
          const approval = message["approval"] as Approval;
          return setChat((c) => ({ ...c, asks: [...c.asks.filter((a) => a.id !== approval.id), approval] }));
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
  // What answers, asked for once there is a KOS to ask.
  useEffect(() => {
    if (online && kos && shownOnce) port.current?.postMessage({ type: "models" });
  }, [online, kos, shownOnce]);

  const say = useCallback((message: Record<string, unknown>) => {
    setError("");
    port.current?.postMessage(message);
  }, []);
  const send = useCallback(
    (text: string) => {
      const said = text.trim();
      if (!said) return;
      // A command (/new, /switch) is never in the chat's words, so it waits for nothing but its answer.
      setChat((c) => ({ ...c, sending: said.startsWith("/") ? c.sending : [...c.sending, said], working: true, story: undefined, unsent: undefined }));
      clearTimeout(taking.current);
      taking.current = setTimeout(() => giveBack("KOS did not take that. It may be an older KOS without the side panel, or not reachable now; your words are back in the box."), TAKE_MS);
      say({ type: "send", text: said });
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
  return { chat, kos, error, silent, chats, models, reads, say, send, answer, answerRead };
}

/** The chat as KOS says it stands now: the owner's words that arrived leave the waiting ones, and a finished turn's steps are in the chat itself. */
function shown(c: Chat, message: Record<string, unknown>): Chat {
  const conversation = (message["conversation"] as string | null) ?? null;
  const lines = (message["messages"] as Line[]) ?? [];
  const fresh = conversation !== c.conversation && c.conversation !== null;
  const said = lines.filter((l): l is Extract<Line, { role: "you" }> => l.role === "you").map((l) => l.text);
  const sending = fresh ? [] : c.sending.filter((t) => !said.includes(t));
  const notice = message["notice"] as { text: string; from?: string; waiting?: true } | undefined;
  // A wait said before is over once the chat is shown again: decided, or still asked in its own card.
  const kept = fresh ? [] : c.extras.filter((x) => !x.waiting);
  const extras = [...kept, ...(notice ? [{ after: yours(lines), text: notice.text, ...(notice.from ? { from: notice.from } : {}), ...(notice.waiting ? { waiting: true as const } : {}) }] : [])];
  const answered = !sending.length && (notice !== undefined || lines.at(-1)?.role !== "you");
  return {
    ...c,
    conversation,
    title: String(message["title"] ?? "Chrome"),
    lines,
    sending,
    extras,
    working: sending.length > 0 || (c.working && !answered),
    ...(answered ? { story: undefined } : {}),
    ...(fresh ? { asks: [] } : {}),
  };
}

function storied(c: Chat, message: Record<string, unknown>): Chat {
  const story = message["story"];
  // A failed turn: what is still waiting was never taken, and goes back to the owner.
  if (typeof message["error"] === "string") return { ...c, working: false, story: undefined, sending: [], ...(c.sending.length ? { unsent: c.sending.join("\n") } : {}) };
  if (typeof story !== "string") return { ...c, working: false };
  const after = yours(c.lines) + c.sending.length;
  // The steps a finished turn already shows, told once more as it closed: nothing new.
  if (!c.sending.length && answeredWith(c.lines, after) >= stepsIn(story)) return c;
  return { ...c, working: true, story: { after, text: story } };
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

function useWorkerState(): PopupState | undefined {
  const [state, setState] = useState<PopupState>();
  useEffect(() => {
    const read = (): void => void ask<PopupState>({ type: "state" }).then(setState, () => undefined);
    read();
    const timer = setInterval(read, 2_000);
    return () => clearInterval(timer);
  }, []);
  return state;
}

function Panel(): ReactElement {
  const [windowId, setWindowId] = useState<number>();
  useEffect(() => void chrome.windows.getCurrent().then((w) => setWindowId(w.id)), []);
  const state = useWorkerState();
  const tab = useTab(windowId);
  const reading = useReading();
  const [kosId, setKosId] = useState<string | null>(null);
  const k = state?.kos.find((x) => x.id === kosId);
  const online = !!k && k.link === "online" && !k.held;
  const { chat, kos, error, silent, chats, models, reads, say, send, answer, answerRead } = useChat(windowId, online);
  useEffect(() => setKosId(kos), [kos]);
  const [switching, setSwitching] = useState(false);
  const usable = online && !silent;
  const mood: BlobMood = !online ? "asleep" : chat.asks.length || chat.consent || reads.length ? "needs-you" : chat.working ? "working" : "idle";
  return (
    <div className="panel">
      <header className="panel-head">
        <Face size={30} mood={mood} />
        <div className="head-text">
          <strong>KOS</strong>
          {usable ? (
            <button
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
                <Icon path={ICONS.chevron} size={11} />
              </m.span>
            </button>
          ) : (
            <span className="sub">{state?.kos.length ? (silent ? "This KOS cannot talk here yet" : "Not connected") : "Not paired yet"}</span>
          )}
        </div>
        {state && state.kos.length > 1 && <KosPicker all={state.kos} chosen={kos} choose={(id) => say({ type: "kos", id })} />}
        {usable && (
          <button type="button" className="icon-btn" aria-label="New chat" title="New chat" onClick={() => send("/new")}>
            <Icon path={ICONS.compose} size={14} />
          </button>
        )}
        <AnimatePresence>
          {switching && usable && (
            <ChatSwitcher
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
      <TabBar tab={tab} state={state} reading={reading} />
      {!state?.kos.length ? (
        <Unpaired />
      ) : silent ? (
        <Silent />
      ) : (
        <>
          <Thread chat={chat} online={online} send={send} answer={answer} reads={reads} answerRead={answerRead} />
          <AnimatePresence>
            {error && (
              <m.p className="error panel-error" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={ease}>
                {error}
              </m.p>
            )}
          </AnimatePresence>
          <Composer online={online} k={k} send={send} unsent={chat.unsent} models={models} chooseModel={(model) => say({ type: "model", model })} />
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

/** The tab beside the panel: what it is, and what KOS may do in it. */
function TabBar({ tab, state, reading }: { tab: chrome.tabs.Tab | undefined; state: PopupState | undefined; reading: { can: boolean; allow: () => void } }): ReactElement | null {
  if (!tab) return null;
  const url = tab.url ?? "";
  const web = /^https?:\/\//.test(url);
  const host = web ? new URL(url).host : "";
  const hidden = web && !!state && isHidden(url, state.settings.hiddenSites);
  const session = state?.session;
  const here = session?.beside !== undefined && session.beside === tab.id;
  const pill: [string, Tone] = !web ? ["Not a web page", "muted"] : hidden ? ["Hidden from KOS", "muted"] : here ? [session.paused ? "You have it" : "KOS is working", session.paused ? "warn" : "accent"] : reading.can ? ["KOS can read", "ok"] : ["Not read", "muted"];
  return (
    <section className="tabbar" data-live={here || undefined}>
      <div className="line">
        <span className="tile tile--sm">{tab.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <Icon path={ICONS.globe} size={13} />}</span>
        <div className="line-text">
          <strong>{tab.title || host || "This tab"}</strong>
          <span>{here ? `${session.task} · ${minutesLeft(session.until)}` : host || url}</span>
        </div>
        <Pill tone={pill[1]}>{pill[0]}</Pill>
      </div>
      <Collapse open={here}>
        <div className="row">
          <button type="button" className="btn btn--sm" onClick={() => void ask({ type: session?.paused ? "handback" : "take" })}>
            {session?.paused ? "Hand back" : "Take over"}
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => void ask({ type: "stop" })}>
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
function ChatSwitcher({ chats, current, pick, close }: { chats: ChatItem[]; current: string | null; pick: (id: string | null) => void; close: () => void }): ReactElement {
  const [q, setQ] = useState("");
  const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    const away = (e: globalThis.KeyboardEvent): void => (e.key === "Escape" ? close() : undefined);
    addEventListener("keydown", away);
    return () => removeEventListener("keydown", away);
  }, [close]);
  return (
    <m.div className="switcher" initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={ease}>
      <button type="button" className="switcher-row switcher-new" onClick={() => pick(null)}>
        <Icon path={ICONS.compose} size={13} />
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
    <div className="empty">
      <Face size={56} mood="error" />
      <strong>This KOS cannot talk here yet</strong>
      <p className="hint">It is connected, but it does not answer the side panel. Update KOS, restart it, then reopen this panel. Its other work in this Chrome is not affected.</p>
    </div>
  );
}

function Unpaired(): ReactElement {
  return (
    <div className="empty">
      <Face size={64} mood="asleep" />
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
}: {
  chat: Chat;
  online: boolean;
  send: (t: string) => void;
  answer: (m: Record<string, unknown>) => void;
  reads: ReadAsk[];
  answerRead: (id: string, granted: boolean) => void;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  const empty = !chat.lines.length && !chat.sending.length && !chat.extras.length;
  const items: ReactNode[] = [];
  let seen = 0;
  const after = (n: number): void => {
    chat.extras.forEach((x, i) => (x.after === n ? items.push(<Extra key={`x${i}`} extra={x} />) : undefined));
    if (chat.story?.after === n) items.push(<Story key={`story${n}`} text={chat.story.text} />);
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
    items.push(<LineView key={`s${i}-${text.slice(0, 16)}`} line={{ role: "you", text }} pending />);
  });
  after(seen);
  return (
    <div
      className="thread"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {empty ? (
        <m.div className="empty" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={ease}>
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
      <AnimatePresence>
        {chat.working && !chat.story && (
          <m.div key="thinking" className="thinking" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={ease}>
            <span />
            <span />
            <span />
          </m.div>
        )}
        {chat.asks.map((a) => (
          <AskCard key={`ask${a.id}`} approval={a} decide={(approved) => answer({ type: "decide", approval: a.id, approved })} />
        ))}
        {chat.consent && <ConsentCard key={`consent${chat.consent.id}`} request={chat.consent} answer={(allowed, minutes) => answer({ type: "consent.answer", id: chat.consent!.id, allowed, minutes })} />}
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
          {line.text && <p>{line.text}</p>}
          {line.files?.length ? (
            <div className="files">
              {line.files.map((f) => (
                <span key={f} className="file-chip">
                  <Icon path={ICONS.page} size={11} />
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

/** The steps a turn took, folded to a count; open to read them. */
function Steps({ steps, live }: { steps: { summary: string; failed?: true }[]; live?: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((s) => s.failed).length;
  return (
    <m.div className="steps" data-live={live || undefined} layout="position" {...enter}>
      <button type="button" className="steps-head" aria-expanded={open || !!live} onClick={() => setOpen(!open)}>
        <Icon path={ICONS.steps} size={12} />
        <span>
          {live ? `${steps.length > 1 ? `${steps.length}. ` : ""}${steps.at(-1)?.summary ?? "Working"}` : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
          {failed ? ` · ${failed} failed` : ""}
        </span>
        {!live && (
          <m.span className="chev" animate={{ rotate: open ? 180 : 0 }} transition={spring}>
            <Icon path={ICONS.chevron} size={11} />
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
    </m.div>
  );
}

/** The running turn: its steps so far, and what KOS is saying between them. */
function Story({ text }: { text: string }): ReactElement {
  const lines = text.split("\n").filter((l) => l.trim());
  const steps = lines.filter((l) => l.startsWith(STEP)).map((l) => ({ summary: l.slice(STEP.length).replace(/ \(failed\)$/, ""), ...(l.endsWith(" (failed)") ? { failed: true as const } : {}) }));
  const words = lines.filter((l) => !l.startsWith(STEP)).join("\n");
  return (
    <>
      {steps.length > 0 && <Steps steps={steps} live />}
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

function AskCard({ approval, decide }: { approval: Approval; decide: (approved: boolean) => void }): ReactElement {
  return (
    <m.section className="card ask-card" layout {...enter}>
      <p className="label">KOS asks to run</p>
      <strong className="mono">{approval.tool}</strong>
      {approval.why && <p className="hint">{approval.why}</p>}
      {approval.args && <pre className="args">{approval.args}</pre>}
      <div className="row">
        <button type="button" className="btn" onClick={() => decide(false)}>
          Deny
        </button>
        <button type="button" className="btn btn--primary" onClick={() => decide(true)}>
          Approve
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

function ConsentCard({ request, answer }: { request: ConsentRequest; answer: (allowed: boolean, minutes: number) => void }): ReactElement {
  const [minutes, setMinutes] = useState(request.minutes);
  const choices = [...new Set([5, 15, 30, 60, 120].filter((v) => v <= Math.min(request.longest, Math.max(request.minutes, 5))).concat(request.minutes))].sort((a, b) => a - b);
  return (
    <m.section className="card ask-card ask-card--consent" layout {...enter}>
      <p className="label">KOS wants to work in this tab</p>
      <p className="quote">{request.task}</p>
      <Chips options={choices.map((v) => [v, minutesWords(v)])} selected={minutes} onChoose={setMinutes} />
      <p className="hint">It works in the tab beside this panel, with a border on it. Click or type there to take over; Stop ends it.</p>
      <div className="row">
        <button type="button" className="btn" onClick={() => answer(false, 0)}>
          Deny
        </button>
        <button type="button" className="btn btn--primary" autoFocus onClick={() => answer(true, minutes)}>
          Allow
        </button>
      </div>
    </m.section>
  );
}

function Composer({
  online,
  k,
  send,
  unsent,
  models,
  chooseModel,
}: {
  online: boolean;
  k: KosState | undefined;
  send: (t: string) => void;
  unsent: string | undefined;
  models: Models | undefined;
  chooseModel: (model: string) => void;
}): ReactElement {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
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
    send(text);
    setText("");
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      go();
    }
  };
  return (
    <div className="composer" data-off={!online || undefined}>
      <textarea
        ref={box}
        rows={1}
        value={text}
        placeholder={online ? "Ask KOS" : k?.held ? "Disconnected. Connect it from the KOS icon." : "KOS is not connected"}
        disabled={!online}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
        autoFocus
      />
      <div className="composer-foot">
        <ModelChoice models={models} choose={chooseModel} />
        <m.button type="button" className="send" aria-label="Send" disabled={!online || !text.trim()} onClick={go} whileTap={{ scale: 0.9 }} transition={spring}>
          <Icon path={ICONS.send} size={15} />
        </m.button>
      </div>
    </div>
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
      <Icon path={ICONS.chevron} size={10} />
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
