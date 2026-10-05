import { Fragment, useEffect, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { api } from "./api.js";
import { useProgress } from "./progress.js";
import { LiveTurn } from "./LiveTurn.js";
import { Markdown } from "./Markdown.js";
import { spring } from "./motion.js";

/**
 * A quick question on the side, like Claude Code's /btw.
 *
 * It is asked about the chat you have open: KOS answers with that chat's
 * history as context, but nothing is recorded into it, so an aside never
 * derails the thread it is about. The side thread is kept per chat for the
 * life of the page, so a follow-up keeps its context too. With no chat open
 * it is a plain question to KOS.
 *
 * Cmd/Ctrl+Shift+K toggles it, beside Cmd+K for the palette; Escape closes it.
 */

interface Aside {
  q: string;
  /** Undefined while the answer is still streaming. */
  a?: string;
}

export function QuickAsk({
  onOpen,
  contextId,
  contextTitle,
}: {
  onOpen: (id: string) => void;
  /** The chat currently open, whose history the aside is answered against. */
  contextId?: string;
  contextTitle?: string;
}): ReactElement {
  const key = contextId ?? "global";
  // The server streams the aside's live view under this key, never under the
  // chat's own id, so the main transcript stays untouched.
  const progressKey = `aside:${key}`;
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Record<string, Aside[]>>({});
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const progress = useProgress();
  const live = progress[progressKey];
  const bodyRef = useRef<HTMLDivElement>(null);
  const thread = threads[key] ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Cmd/Ctrl+Shift+K, beside Cmd+K for the palette. (Cmd+J was the
      // browser's Downloads shortcut and never reached the page.)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Keep the newest exchange in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, live?.text, live?.steps.length, open]);

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

  return (
    <>
      <button
        type="button"
        className={`quickask-fab ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="Quick question"
        title="Quick question (Cmd/Ctrl+Shift+K)"
      >
        <span aria-hidden="true">✦</span>
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            className="quickask"
            role="dialog"
            aria-label="Quick question"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.98 }}
            transition={spring}
          >
            <header className="quickask-head">
              <div className="quickask-title-wrap">
                <span className="quickask-title">
                  <span className="quickask-glyph" aria-hidden="true">
                    ✦
                  </span>
                  Quick question
                </span>
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
                {contextId && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      onOpen(contextId);
                      setOpen(false);
                    }}
                  >
                    Go to chat
                  </button>
                )}
                <button
                  type="button"
                  className="quickask-close"
                  onClick={() => setOpen(false)}
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
                    ? "Ask a side question about this chat. KOS answers with its context, and the chat itself is left as it is."
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
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}
