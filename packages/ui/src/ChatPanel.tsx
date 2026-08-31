import { useEffect, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease, spring } from "./motion.js";
import { composerKeyDown, useStickToBottom } from "./composer.js";
import type { ChatEvent } from "./api.js";
import { Markdown } from "./Markdown.js";
import { ToolCall } from "./ToolCall.js";

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
  thread: ChatEvent[];
  prompt: string;
  sending: boolean;
  onPrompt: (value: string) => void;
  onSend: () => void;
  onClose: () => void;
  onClear: () => void;
  pendingApprovals: Set<string>;
  onDecide: (pendingId: string, approved: boolean) => void;
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
  pendingApprovals,
  onDecide,
}: ChatPanelProps): ReactElement | null {
  const boxRef = useRef<HTMLDivElement>(null);
  // A routing question fits in a sheet; reading what a dispatched agent did,
  // with its tool calls open, does not.
  const [full, setFull] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the conversation as it grows, and land focus in the input on open.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useStickToBottom(boxRef, [thread, sending, open]);

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
            className={`sheet ${full ? "sheet--full" : ""}`}
            aria-label="Chat with KOS"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={spring}
          >
            <header className="sheet-head">
              <div className="sheet-title">
                <strong>Command</strong>
                <span className="sheet-sub">routes work across your chats</span>
              </div>
              <div className="sheet-head-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setFull((v) => !v)}
                  aria-label={full ? "Shrink" : "Expand to full screen"}
                  title={full ? "Shrink" : "Expand"}
                >
                  {full ? "⤡" : "⤢"}
                </button>
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
                  Say what you want to work on. This one looks across your
                  chats, finds where it belongs, and starts a new one if it
                  needs to.
                </p>
              )}
              {/* The orchestrator works by calling tools; hiding them would
                  show its conclusions with no visible reason for them. */}
              {thread.map((e, i) =>
                e.kind === "tool" ? (
                  <ToolCall
                    key={i}
                    event={e}
                    awaitingApproval={
                      e.pendingId !== undefined && pendingApprovals.has(e.pendingId)
                    }
                    onDecide={onDecide}
                  />
                ) : (
                  <div key={i} className={`bubble bubble--${e.role}`}>
                    <Markdown text={e.text} />
                  </div>
                ),
              )}
              {sending && <div className="bubble bubble--kos is-thinking">thinking…</div>}
            </div>

            <div className="sheet-composer">
              <textarea
                ref={inputRef}
                rows={3}
                value={prompt}
                placeholder="What do you want to work on?"
                onChange={(e) => onPrompt(e.target.value)}
                onKeyDown={(e) => composerKeyDown(e, onSend)}
              />
              <div className="sheet-composer-bar">
                <span className="hint">Enter to send · Shift+Enter for a new line</span>
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
