import type { ReactElement } from "react";
import { createPortal } from "react-dom";

import { AnimatePresence, m } from "motion/react";

import { MENTION_SOURCE } from "@kos/shared";
import { AlertIcon, CheckIcon, CloseIcon, IconButton, spring } from "@kos/kit";

/** A word from KOS about what just happened, and the way to take it back when there is one. */
export interface ToastNote {
  kind: "ok" | "err";
  text: string;
  undo?: () => void;
  /** Shown with a close of its own, for a note that stays until it is read. */
  onDismiss?: () => void;
}

const MENTION = new RegExp(MENTION_SOURCE, "g");

/**
 * The words a toast says, with references said as a reader would: a toast
 * draws no chips, so "Approved @approval:2." printed the token. An approval
 * is its number; anything else its name.
 */
export function toastWords(text: string): string {
  return text.replace(MENTION, (_whole, kind: string, bracketed?: string, plain?: string) => (kind === "approval" ? `#${plain ?? bracketed ?? ""}` : (bracketed ?? plain ?? "")));
}

/**
 * The one toast: a pill at the bottom, centred, with a mark that says how it
 * went, Undo when it can be undone. Approve, archive and the files each drew
 * their own, at the top, across the pane and at the bottom.
 */
export function Toast({ note }: { note: ToastNote | null }): ReactElement {
  // On the body: a pane that is hidden (the thread, on a phone showing the list) hides what is fixed inside it too.
  return createPortal(
    <AnimatePresence>
      {note && (
        <m.div
          key={note.text}
          className={`ops-toast ops-toast--${note.kind}`}
          role={note.kind === "err" ? "alert" : "status"}
          initial={{ opacity: 0, y: 10, x: "-50%", scale: 0.97 }}
          animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
          exit={{ opacity: 0, y: 6, x: "-50%", scale: 0.98 }}
          transition={spring}
        >
          <span className="ops-toast-icon" aria-hidden="true">
            {note.kind === "ok" ? <CheckIcon size={12} title="" /> : <AlertIcon size={12} />}
          </span>
          <span className="ops-toast-text">{toastWords(note.text)}</span>
          {note.undo && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={note.undo}>
              Undo
            </button>
          )}
          {note.onDismiss && (
            <IconButton tone="bare" label="Dismiss" onClick={note.onDismiss}>
              <CloseIcon size={12} title="" />
            </IconButton>
          )}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
