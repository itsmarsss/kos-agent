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
 * It is a window, not a widget: drag it by its header, resize it by its
 * corner, and it opens where you left it. Opening is the app's business
 * (the sidebar entry or Cmd/Ctrl+Shift+K); this only renders while `open`.
 * The entrance is a CSS fade rather than a motion transform: a transform
 * fought the window's own geometry, which is set by left/top/width/height
 * and changed by the resize handle.
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

const BOX_KEY = "kos.quick.box";
const EDGE = 8;
const MIN_W = 280;
const MIN_H = 224;

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
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** The chat currently open, whose history the aside is answered against. */
  contextId?: string;
  contextTitle?: string;
}): ReactElement | null {
  const key = contextId ?? "global";
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
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const thread = threads[key] ?? [];

  // Stay on screen if the window shrinks underneath it.
  useEffect(() => {
    const onResize = (): void => setBox((b) => clamp(b));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The corner handle changes the element's size directly; follow it so the
  // size is remembered and the box stays the single source of truth.
  useEffect(() => {
    const el = panelRef.current;
    if (!open || !el) return;
    const ro = new ResizeObserver(() => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const b = boxRef.current;
      if (Math.abs(width - b.width) < 1 && Math.abs(height - b.height) < 1) return;
      const next = clamp({ ...b, width, height });
      setBox(next);
      saveBox(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Keep the newest exchange in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, live?.text, live?.steps.length, open]);

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
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    saveBox(boxRef.current);
  };

  const setAnswer = (answer: string): void =>
    setThreads((all) => {
      const list = [...(all[key] ?? [])];
      const last = list.length - 1;
      if (last >= 0) list[last] = { ...list[last]!, a: answer };
      return { ...all, [key]: list };
    });

  const ask = async (): Promise<void> => {
    const q = text.trim();
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
      const res = await api.aside(q, contextId, prior);
      setAnswer(res.reply);
    } catch (err) {
      setAnswer(`It failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAsking(false);
    }
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="quickask"
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
            {contextId ? (
              <>
                about <b>{contextTitle ?? contextId}</b>, without adding to it
              </>
            ) : (
              "no chat open, so a plain question to KOS"
            )}
          </span>
        </div>
        <div className="quickask-head-actions">
          {thread.length > 0 && (
            <button
              type="button"
              className="link"
              onClick={() => setThreads((all) => ({ ...all, [key]: [] }))}
              title="Forget this side thread"
            >
              Clear
            </button>
          )}
          {contextId && (
            <button
              type="button"
              className="link"
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
            className="quickask-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </header>
      <div className="quickask-body" ref={bodyRef}>
        {thread.length === 0 && (
          <p className="quickask-empty">
            {contextId
              ? "Ask a side question about this chat. KOS answers from its context, with no tools, and the chat itself is left as it is."
              : "Open a chat to ask about it, or just ask KOS something."}
          </p>
        )}
        {thread.map((t, i) => {
          const pending = i === thread.length - 1 && t.a === undefined;
          return (
            <Fragment key={i}>
              <div className="quickask-turn quickask-turn--you">
                <Markdown text={t.q} />
              </div>
              {t.a !== undefined ? (
                <div className="quickask-turn quickask-turn--kos">
                  <Markdown text={t.a} />
                </div>
              ) : pending && live && !live.ended ? (
                <div className="quickask-turn quickask-turn--kos">
                  <LiveTurn live={live} />
                </div>
              ) : pending ? (
                <div className="quickask-turn quickask-turn--kos quickask-wait">Thinking…</div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
      <form
        className="quickask-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <textarea
          className="quickask-input"
          rows={1}
          autoFocus
          value={text}
          placeholder={contextId ? "Ask about this chat…" : "Ask KOS…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={asking || !text.trim()}
        >
          {asking ? "…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
