import { useEffect, useRef, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease, spring } from "./motion.js";

/**
 * Chat as a slide-over rather than a permanent panel. KOS is mostly reached
 * from Discord; on the dashboard it is something you summon (cmd-K), not the
 * thing that occupies the screen while you look at your data.
 */

export interface ChatMessage {
  role: "you" | "kos";
  text: string;
}

export interface ChatPanelProps {
  open: boolean;
  thread: ChatMessage[];
  prompt: string;
  sending: boolean;
  onPrompt: (value: string) => void;
  onSend: () => void;
  onClose: () => void;
  onClear: () => void;
}

export function ChatPanel({
  open,
  thread,
  prompt,
  sending,
  onPrompt,
  onSend,
  onClose,
  onClear,
}: ChatPanelProps): ReactElement | null {
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the conversation as it grows, and land focus in the input on open.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [thread, sending]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            key="backdrop"
            className="sheet-backdrop"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={ease}
          />
          <m.aside
            key="sheet"
            className="sheet"
            aria-label="Chat with KOS"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={spring}
          >
            <header className="sheet-head">
              <div>
                <strong>Ask KOS</strong>
                <span className="sheet-sub">same conversation as Discord</span>
              </div>
              <div className="sheet-head-actions">
                <button type="button" className="btn btn--ghost" onClick={onClear}>
                  Clear
                </button>
                <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
                  ✕
                </button>
              </div>
            </header>

            <div className="sheet-thread" ref={boxRef} aria-live="polite">
              {thread.length === 0 && (
                <p className="sheet-empty">
                  Ask for anything: “what did I spend on coffee”, “build me a reading
                  list”, “remind me to review the budget on Mondays”.
                </p>
              )}
              {thread.map((m, i) => (
                <div key={i} className={`bubble bubble--${m.role}`}>
                  {m.text}
                </div>
              ))}
              {sending && <div className="bubble bubble--kos is-thinking">thinking…</div>}
            </div>

            <div className="sheet-composer">
              <textarea
                ref={inputRef}
                rows={3}
                value={prompt}
                placeholder="Ask KOS…"
                onChange={(e) => onPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    onSend();
                  }
                }}
              />
              <div className="sheet-composer-bar">
                <span className="hint">⌘↵ to send</span>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onSend}
                  disabled={sending || prompt.trim() === ""}
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </m.aside>
        </>
      )}
    </AnimatePresence>
  );
}
