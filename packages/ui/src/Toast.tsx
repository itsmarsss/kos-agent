import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { AnimatePresence, m } from "motion/react";

import { MENTION_SOURCE } from "@kos/shared";
import { AlertIcon, announce, CheckIcon, CloseIcon, IconButton, InfoIcon, spring, WorkingDots } from "@kos/kit";

/**
 * How it went: `ok` it was done (a check), `info` it was done and is a no
 * or a nothing (Denied, Halted: a quiet mark, never the green check), `warn`
 * it was done but something did not follow, `err` it was not done.
 */
export type ToastTone = "ok" | "info" | "warn" | "err";

/** A word from KOS about what just happened, and the way to take it back when there is one. */
export interface ToastNote {
  kind: ToastTone;
  text: string;
  undo?: () => void;
  /** Shown with a close of its own, for a note that stays until it is read. */
  onDismiss?: () => void;
  /** Still under way (an export): the working dots after the words, in place of a mark. */
  working?: boolean;
}

/** How long a note stays, unless it holds an Undo, which stays a little longer to be reached. */
export const TOAST_MS = 3200;
const UNDO_MS = 6000;
/** At most this many on screen; an older one gives way to a new. */
const MOST = 3;

interface Entry extends ToastNote {
  id: number;
}

/**
 * The one queue every toast goes through. Keyed by id, not by its words, so
 * the same words twice ("Saved", "Saved") show twice; each has its own timer,
 * cleared when it goes, so an early timer never takes a later note down.
 */
let shown: readonly Entry[] = [];
let next = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const changed = (list: readonly Entry[]): void => {
  shown = list;
  for (const l of listeners) l();
};

/** Say something; it goes by itself after `ms` (null: when `dismissToast` is called). The id it was given. */
export function toast(note: ToastNote, ms: number | null = note.undo ? UNDO_MS : TOAST_MS): number {
  const id = next++;
  // The same words again replace the last of them rather than stacking a twin.
  const twin = shown.find((e) => e.text === note.text && e.kind === note.kind);
  if (twin) dismissToast(twin.id);
  const list = [...shown, { ...note, id }];
  for (const gone of list.slice(0, Math.max(0, list.length - MOST))) clearTimer(gone.id);
  changed(list.slice(-MOST));
  if (ms !== null) {
    spans.set(id, ms);
    timers.set(id, setTimeout(() => dismissToast(id), ms));
  }
  // Heard as well as seen, through the one announcer: a node that speaks for itself as it is made is not heard by many readers.
  announce(`${toastWords(note.text)}${note.undo ? ". Undo is in the note." : ""}`, note.kind === "err" ? "assertive" : "polite");
  return id;
}

/** How long each note was given, so one held under the pointer or the keys gets all of it again once let go. */
const spans = new Map<number, number>();

/**
 * Where the focus was before it came into a toast (a press on Undo takes it
 * there), to be given back when the toast's button has done its work: the
 * toast going took the focus to the page's body, and the list the Undo put
 * a file back in no longer had the keys.
 */
let cameFrom: HTMLElement | null = null;

/** A toast's button pressed: its work, the toast gone, and the focus back where it was. */
function settle(id: number, work?: () => void): void {
  work?.();
  dismissToast(id);
  // Only while the focus is still on the toast: the work may have put it somewhere of its own.
  if (cameFrom?.isConnected && document.activeElement?.closest(".ops-toasts")) cameFrom.focus({ preventScroll: true });
  cameFrom = null;
}

/** A note being read (the pointer on it, or the focus in it, as on its Undo) stays until it is let go. */
function hold(id: number): void {
  clearTimer(id);
}

function letGo(id: number): void {
  const ms = spans.get(id);
  if (ms === undefined || !shown.some((e) => e.id === id)) return;
  clearTimer(id);
  timers.set(id, setTimeout(() => dismissToast(id), ms));
}

export function dismissToast(id: number): void {
  clearTimer(id);
  spans.delete(id);
  if (shown.some((e) => e.id === id)) changed(shown.filter((e) => e.id !== id));
}

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

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
 * A note a page holds while something is so (an Undo for what it just
 * archived, a file operation's word): in the one queue while `note` is set,
 * gone when it is cleared. Keyed by its words, so a parent that builds the
 * note afresh each render does not show it again each render.
 */
export function Toast({ note }: { note: ToastNote | null | undefined | false }): null {
  const latest = useRef(note || null);
  latest.current = note || null;
  const kind = note ? note.kind : null;
  const text = note ? note.text : null;
  const undo = Boolean(note && note.undo);
  const dismissable = Boolean(note && note.onDismiss);
  const working = Boolean(note && note.working);
  useEffect(() => {
    if (kind === null || text === null) return;
    const id = toast(
      {
        kind,
        text,
        ...(undo ? { undo: () => latest.current?.undo?.() } : {}),
        ...(dismissable ? { onDismiss: () => latest.current?.onDismiss?.() } : {}),
        ...(working ? { working } : {}),
      },
      null,
    );
    return () => dismissToast(id);
  }, [kind, text, undo, dismissable, working]);
  return null;
}

/**
 * Above the composer when one is on screen, so a note never covers the box
 * being typed in, and centred on it: on the column it lifts over, not on the
 * window, which beside the chat list put it off to one side of the box.
 */
function useLift(): { lift: number; centre: number | null } {
  const [lift, setLift] = useState<{ lift: number; centre: number | null }>({ lift: 0, centre: null });
  const list = useSyncExternalStore(subscribe, () => shown);
  useLayoutEffect(() => {
    if (list.length === 0) return;
    const measure = (): void => {
      const box = document.querySelector<HTMLElement>(".composer");
      const at = box && box.offsetParent !== null ? box.getBoundingClientRect() : null;
      setLift(at && at.top < window.innerHeight ? { lift: Math.max(0, window.innerHeight - at.top), centre: at.left + at.width / 2 } : { lift: 0, centre: null });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [list]);
  return lift;
}

const MARK: Record<ToastTone, () => ReactElement> = {
  ok: () => <CheckIcon size={12} title="" />,
  info: () => <InfoIcon size={12} />,
  warn: () => <AlertIcon size={12} />,
  err: () => <AlertIcon size={12} />,
};

/**
 * The one place toasts are drawn: a stack at the bottom, centred, lifted
 * over the composer when there is one, each with a mark that says how it
 * went and Undo when it can be undone. Mounted once, by the app.
 */
export function ToastHost(): ReactElement {
  const list = useSyncExternalStore(subscribe, () => shown);
  const { lift, centre } = useLift();
  // Centred on the composer's column: the stack is as wide as twice the room on the box's nearer side.
  const half = centre === null ? null : Math.min(centre, window.innerWidth - centre);
  const place = lift ? { bottom: `calc(${lift}px + 0.75rem)`, ...(half !== null ? { left: `${centre! - half}px`, right: `${window.innerWidth - centre! - half}px` } : {}) } : undefined;
  // On the body: a pane that is hidden (the thread, on a phone showing the list) hides what is fixed inside it too.
  return createPortal(
    <div className="ops-toasts" style={place}>
      <AnimatePresence initial={false}>
        {list.map((note) => {
          const Mark = MARK[note.kind];
          return (
            <m.div
              key={note.id}
              layout
              className={`ops-toast ops-toast--${note.kind}`}
              onPointerEnter={() => hold(note.id)}
              onPointerLeave={() => letGo(note.id)}
              onFocus={(e) => {
                hold(note.id);
                const from = e.relatedTarget;
                if (from instanceof HTMLElement && !from.closest(".ops-toasts")) cameFrom = from;
              }}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) letGo(note.id);
              }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={spring}
            >
              {!note.working && (
                <span className="ops-toast-icon" aria-hidden="true">
                  <Mark />
                </span>
              )}
              <span className="ops-toast-text">{toastWords(note.text)}</span>
              {note.working && <WorkingDots />}
              {note.undo && (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => settle(note.id, note.undo)}
                >
                  Undo
                </button>
              )}
              {note.onDismiss && (
                <IconButton
                  tone="bare"
                  label="Dismiss"
                  onClick={() => settle(note.id, note.onDismiss)}
                >
                  <CloseIcon size={12} title="" />
                </IconButton>
              )}
            </m.div>
          );
        })}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
