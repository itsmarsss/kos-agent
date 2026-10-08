import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import { api } from "./api.js";
import { useProgress } from "./progress.js";
import { LiveTurn } from "./LiveTurn.js";
import { Markdown } from "./Markdown.js";

/**
 * A quick question on the side, like Claude Code's /btw.
 *
 * It is asked about the chat you have open: KOS answers with that chat's
 * history as context, with no tools, and nothing is recorded into the chat,
 * so an aside never derails the thread it is about. The side thread is kept
 * per chat for the life of the page, so a follow-up keeps its context, and
 * Clear forgets it. With no chat open it is a plain question to KOS.
 *
 * It is a window, not a widget: drag it by its header, resize it by any
 * edge or corner, and it opens where you left it. Opening is the app's
 * business (the sidebar entry or Cmd/Ctrl+Shift+K); this fades in while
 * `open` and fades out when it stops being. The geometry is left/top/width/
 * height set here, so the fades are CSS and never touch the transform.
 */

interface Aside {
  q: string;
  /** Undefined while the answer is still streaming. */
  a?: string;
}

/** Where the window sits and how big it is, in viewport pixels. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: readonly Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const BOX_KEY = "kos.quick.box";
const EDGE = 8;
const MIN_W = 280;
const MIN_H = 224;
/** How long the fade out runs; the window unmounts after it. */
const FADE_MS = 140;

function clamp(b: Box): Box {
  const width = Math.max(MIN_W, Math.min(b.width, window.innerWidth - EDGE * 2));
  const height = Math.max(MIN_H, Math.min(b.height, window.innerHeight - EDGE * 2));
  return {
    width,
    height,
    left: Math.max(EDGE, Math.min(b.left, window.innerWidth - width - EDGE)),
    top: Math.max(EDGE, Math.min(b.top, window.innerHeight - height - EDGE)),
  };
}

/** The box after one of its edges moved by (dx, dy). The opposite edge stays put. */
function resized(from: Box, edge: Edge, dx: number, dy: number): Box {
  let { left, top, width, height } = from;
  const right = from.left + from.width;
  const bottom = from.top + from.height;
  if (edge.includes("e")) width = Math.max(MIN_W, Math.min(from.width + dx, window.innerWidth - EDGE - from.left));
  if (edge.includes("s")) height = Math.max(MIN_H, Math.min(from.height + dy, window.innerHeight - EDGE - from.top));
  if (edge.includes("w")) {
    left = Math.max(EDGE, Math.min(from.left + dx, right - MIN_W));
    width = right - left;
  }
  if (edge.includes("n")) {
    top = Math.max(EDGE, Math.min(from.top + dy, bottom - MIN_H));
    height = bottom - top;
  }
  return { left, top, width, height };
}

/** The remembered box, or a first-time one tucked into the bottom right. */
function readBox(): Box {
  try {
    const raw = localStorage.getItem(BOX_KEY);
    if (raw) return clamp(JSON.parse(raw) as Box);
  } catch {
    /* private window, or a stale shape */
  }
  const width = Math.min(368, window.innerWidth - EDGE * 2);
  const height = Math.min(460, window.innerHeight - EDGE * 2);
  return clamp({
    left: window.innerWidth - width - 18,
    top: window.innerHeight - height - 18,
    width,
    height,
  });
}

function saveBox(b: Box): void {
  try {
    localStorage.setItem(BOX_KEY, JSON.stringify(b));
  } catch {
    /* private window */
  }
}

export function QuickAsk({
  open,
  onClose,
  onOpen,
  contextId,
  contextTitle,
  seed,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** The chat currently open, whose history the aside is answered against. */
  contextId?: string;
  contextTitle?: string;
  /** A question handed in from outside (`/btw` in the chat), asked as it arrives. */
  seed?: { text: string; n: number };
}): ReactElement | null {
  /*
   * Detached, the question is a plain one to KOS with no chat behind it,
   * even while a chat is open: for the question that has nothing to do
   * with what is on screen. The choice sticks until it is changed.
   */
  const [detached, setDetached] = useState(false);
  const attachedTo = contextId !== undefined && !detached ? contextId : undefined;
  const key = attachedTo ?? "global";
  // The server streams the aside's live view under this key, never under the
  // chat's own id, so the main transcript stays untouched.
  const progressKey = `aside:${key}`;
  const [threads, setThreads] = useState<Record<string, Aside[]>>({});
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [box, setBox] = useState<Box>(readBox);
  const boxRef = useRef(box);
  boxRef.current = box;
  const progress = useProgress();
  const live = progress[progressKey];
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resize = useRef<{ edge: Edge; x: number; y: number; box: Box } | null>(null);
  const thread = threads[key] ?? [];

  /*
   * Shown lags open by one fade. Returning null the moment `open` went false
   * skipped the way out entirely, so the window appeared gently and then
   * simply stopped existing.
   */
  const [shown, setShown] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setShown(true);
      setClosing(false);
      return;
    }
    if (!shown) return;
    setClosing(true);
    const t = setTimeout(() => {
      setShown(false);
      setClosing(false);
    }, FADE_MS);
    return () => clearTimeout(t);
    // Keyed on open alone: shown is this effect's own output.
  }, [open]);

  // Stay on screen if the window shrinks underneath it.
  useEffect(() => {
    const onResize = (): void => setBox((b) => clamp(b));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keep the newest exchange in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, live?.text, live?.steps.length, shown]);

  const onDragStart = (e: ReactPointerEvent<HTMLElement>): void => {
    // The header's buttons are buttons, not a grip.
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const b = boxRef.current;
    drag.current = { x: e.clientX, y: e.clientY, left: b.left, top: b.top };
  };
  const onDragMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d) return;
    setBox(
      clamp({
        ...boxRef.current,
        left: d.left + (e.clientX - d.x),
        top: d.top + (e.clientY - d.y),
      }),
    );
  };
  const onDragEnd = (e: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Worked out from the pointer, not read back from state: the last move
    // may not have rendered yet when the button comes up.
    const final = clamp({ ...boxRef.current, left: d.left + (e.clientX - d.x), top: d.top + (e.clientY - d.y) });
    setBox(final);
    saveBox(final);
  };

  const onResizeStart = (edge: Edge) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resize.current = { edge, x: e.clientX, y: e.clientY, box: boxRef.current };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = resize.current;
    if (!r) return;
    setBox(resized(r.box, r.edge, e.clientX - r.x, e.clientY - r.y));
  };
  const onResizeEnd = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = resize.current;
    if (!r) return;
    resize.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const final = resized(r.box, r.edge, e.clientX - r.x, e.clientY - r.y);
    setBox(final);
    saveBox(final);
  };

  const setAnswer = (answer: string): void =>
    setThreads((all) => {
      const list = [...(all[key] ?? [])];
      const last = list.length - 1;
      if (last >= 0) list[last] = { ...list[last]!, a: answer };
      return { ...all, [key]: list };
    });

  const ask = async (q: string): Promise<void> => {
    if (!q || asking) return;
    // Earlier exchanges in this side thread go with the question, so a
    // follow-up ("and the second one?") has what it refers to.
    const prior = thread
      .filter((t): t is Aside & { a: string } => typeof t.a === "string")
      .flatMap((t) => [
        { role: "user" as const, text: t.q },
        { role: "assistant" as const, text: t.a },
      ]);
    setThreads((all) => ({ ...all, [key]: [...(all[key] ?? []), { q }] }));
    setText("");
    setAsking(true);
    try {
      const res = await api.aside(q, attachedTo, prior);
      setAnswer(res.reply);
    } catch (err) {
      setAnswer(`It failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAsking(false);
    }
  };

  // A question handed in is asked once, when it arrives.
  const askedSeed = useRef<number | null>(null);
  useEffect(() => {
    if (!seed || askedSeed.current === seed.n) return;
    askedSeed.current = seed.n;
    void ask(seed.text);
    // ask closes over the thread; the seed's stamp is what makes this fire.
  }, [seed?.n]);

  if (!shown) return null;

  return (
    <div
      className={`quickask ${closing ? "is-closing" : ""}`}
      role="dialog"
      aria-label="Quick question"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <header
        className="quickask-head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <div className="quickask-title-wrap">
          <span className="quickask-title">Quick question</span>
          <span className="quickask-context">
            {attachedTo ? (
              <>
                about <b>{contextTitle ?? contextId}</b>, without adding to it
              </>
            ) : contextId ? (
              <>
                a plain question to KOS, not about <b>{contextTitle ?? contextId}</b>
              </>
            ) : (
              "no chat open, so a plain question to KOS"
            )}
          </span>
        </div>
        <div className="quickask-head-actions">
          {contextId && (
            /* Attached, the open chat is the context; detached, there is
               none, for a question that has nothing to do with it. */
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-pressed={!detached}
              title={detached ? `Ask about ${contextTitle ?? contextId} again` : "Ask without this chat's context"}
              onClick={() => setDetached((v) => !v)}
            >
              {detached ? "Attach" : "Detach"}
            </button>
          )}
          {thread.length > 0 && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setThreads((all) => ({ ...all, [key]: [] }))}
              title="Forget this side thread"
            >
              Clear
            </button>
          )}
          {contextId && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                onOpen(contextId);
                onClose();
              }}
            >
              Go to chat
            </button>
          )}
          <button
            type="button"
            className="icon-btn quickask-close"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <svg
              width="13"
              height="13"
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
        </div>
      </header>
      <div className="quickask-body" ref={bodyRef}>
        {thread.length === 0 && (
          <p className="quickask-empty">
            {attachedTo
              ? "Ask a side question about this chat. KOS answers from its context, with no tools, and the chat itself is left as it is."
              : contextId
                ? "Detached: a plain question to KOS, with nothing from this chat behind it. Attach to ask about the chat."
                : "Open a chat to ask about it, or just ask KOS something."}
          </p>
        )}
        {thread.map((t, i) => {
          const pending = i === thread.length - 1 && t.a === undefined;
          return (
            <Fragment key={i}>
              {/* The chat's own bubbles, smaller. A shape of its own here
                  meant the answer changed face the moment it finished
                  streaming, since the live view was already drawn in the
                  chat's. */}
              <div className="quickask-turn turn turn--you">
                <div className="bubble bubble--you">
                  <Markdown text={t.q} />
                </div>
              </div>
              {t.a !== undefined ? (
                <div className="quickask-turn turn turn--kos">
                  <div className="bubble bubble--kos">
                    <Markdown text={t.a} />
                  </div>
                </div>
              ) : pending && live && !live.ended ? (
                <div className="quickask-turn turn turn--kos quickask-turn--live">
                  <LiveTurn live={live} />
                </div>
              ) : pending ? (
                <div className="quickask-turn turn turn--kos">
                  <div className="bubble bubble--kos is-thinking">Thinking…</div>
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
      <form
        className="quickask-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text.trim());
        }}
      >
        <textarea
          className="quickask-input"
          rows={1}
          autoFocus
          value={text}
          placeholder={attachedTo ? "Ask about this chat…" : "Ask KOS…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {/* One size whether idle or busy: a label that changed width made
            the button jump and shrink to a blob while an answer came. */}
        <button
          type="submit"
          className="btn btn--primary quickask-send"
          disabled={asking || !text.trim()}
          aria-label={asking ? "Asking" : "Ask"}
        >
          {asking ? (
            <span className="live-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : (
            "Ask"
          )}
        </button>
      </form>
      {/* Every edge and corner is a handle, not just the one the browser
          offers; they sit just inside the border, over everything else. */}
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`quickask-edge quickask-edge--${edge}`}
          aria-hidden="true"
          onPointerDown={onResizeStart(edge)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      ))}
    </div>
  );
}
