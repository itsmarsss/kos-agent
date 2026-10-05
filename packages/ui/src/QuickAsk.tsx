import { useEffect, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { api, type ChatTurn } from "./api.js";
import { useProgress } from "./progress.js";
import { LiveTurn } from "./LiveTurn.js";
import { Markdown } from "./Markdown.js";
import { ease, spring } from "./motion.js";

/**
 * A quick question to KOS, on the side.
 *
 * A floating thread that lives over whatever page you are on, so an aside
 * does not mean leaving what you were doing. It reuses one conversation
 * ("Quick questions") so follow-ups keep their context, and "Open in chat"
 * promotes it to the full view when an aside turns into real work.
 *
 * Cmd/Ctrl+J toggles it; Escape closes it.
 */

const QUICK_KEY = "kos.quick.id";

export function QuickAsk({
  onOpen,
}: {
  onOpen: (id: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [quickId, setQuickId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(QUICK_KEY);
    } catch {
      return null;
    }
  });
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const progress = useProgress();
  const live = quickId ? progress[quickId] : undefined;
  const working = Boolean(live) && !live?.ended;
  const bodyRef = useRef<HTMLDivElement>(null);

  // Cmd/Ctrl+J toggles; Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const refresh = (id: string): void => {
    void api
      .conversation(id)
      .then((c) => setTurns(c.messages))
      .catch(() => {
        // The remembered thread was deleted: forget it and start fresh.
        setQuickId(null);
        setTurns([]);
        try {
          localStorage.removeItem(QUICK_KEY);
        } catch {
          /* private window */
        }
      });
  };

  // Load the thread when the panel opens, and again when a reply settles.
  useEffect(() => {
    if (open && quickId) refresh(quickId);
  }, [open, quickId]);
  const ended = live?.ended;
  useEffect(() => {
    if (ended && quickId) refresh(quickId);
  }, [ended, quickId]);

  // Keep the newest exchange in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, live?.text, live?.steps.length, open]);

  const ask = async (): Promise<void> => {
    const q = text.trim();
    if (!q || starting) return;
    setStarting(true);
    try {
      let id = quickId;
      if (!id) {
        const c = await api.newConversation("Quick questions");
        id = c.id;
        setQuickId(id);
        try {
          localStorage.setItem(QUICK_KEY, id);
        } catch {
          /* private window */
        }
      }
      // Show the question at once; the authoritative list replaces this when
      // the reply settles, so there is no duplicate.
      setTurns((t) => [...t, { role: "you", text: q }]);
      setText("");
      void api.message(q, id).catch(() => undefined);
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`quickask-fab ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="Quick question"
        title="Quick question (Cmd/Ctrl+J)"
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
              <span className="quickask-title">
                <span className="quickask-glyph" aria-hidden="true">
                  ✦
                </span>
                Quick question
              </span>
              <div className="quickask-head-actions">
                {quickId && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      onOpen(quickId);
                      setOpen(false);
                    }}
                  >
                    Open in chat
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
              {turns.length === 0 && !working && (
                <p className="quickask-empty">
                  Ask KOS anything on the side. It keeps this thread, so you can
                  follow up. Cmd/Ctrl+J toggles this window.
                </p>
              )}
              {turns.map((t, i) => (
                <div key={i} className={`quickask-turn quickask-turn--${t.role}`}>
                  <Markdown text={t.text} />
                </div>
              ))}
              {working && live && (
                <div className="quickask-turn quickask-turn--kos">
                  <LiveTurn live={live} />
                </div>
              )}
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
                placeholder="Ask a quick question…"
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
                disabled={starting || !text.trim()}
              >
                Ask
              </button>
            </form>
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}
