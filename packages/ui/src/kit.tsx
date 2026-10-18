import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";

import { ease } from "./motion.js";

/**
 * The small parts every page is built from, so they are built the same way.
 *
 * Before this, each page grew its own: five label styles, three kinds of
 * section head, chips in four shapes, and an empty state per page. Moving
 * between pages read as moving between applications. These are the one
 * version of each, and docs/ui.md says when to use which.
 */

/** The mark on a required field's label. */
export function Req(): ReactElement {
  return (
    <span className="field-req" title="Required" aria-label="required">
      *
    </span>
  );
}

export interface FieldProps {
  label: string;
  /** Marked on the label; the form's submit stays off until it is filled. */
  required?: boolean;
  /** A line under the control: what to put here, or what the choice means. */
  hint?: ReactNode;
  /** Shown instead of the hint, in the danger colour, when the value cannot be sent as it is. */
  error?: ReactNode;
  /** Several controls under one label, so the label is a heading rather than a <label>. */
  group?: boolean;
  className?: string;
  children: ReactNode;
}

/** One labelled control: the label, the control, then a hint or an error. */
export function Field({ label, required = false, hint, error, group = false, className, children }: FieldProps): ReactElement {
  const cls = `kos-field${className ? ` ${className}` : ""}`;
  const body = (
    <>
      <span className="kos-field-label">
        {label}
        {required && <Req />}
      </span>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </>
  );
  return group ? (
    <div className={cls} role="group" aria-label={label}>
      {body}
    </div>
  ) : (
    <label className={cls}>{body}</label>
  );
}

export type Tone = "ok" | "warn" | "danger" | "accent" | "muted";

/** A state in a word: on, paused, failed. Coloured by what it means. */
export function Pill({ tone = "muted", title, children }: { tone?: Tone; title?: string; children: ReactNode }): ReactElement {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

/** A fact in a word or two: a tool family, a model class, a type. Not a button. */
export function Tag({ mono = false, title, children }: { mono?: boolean; title?: string; children: ReactNode }): ReactElement {
  return (
    <span className={`tag${mono ? " tag--mono" : ""}`} title={title}>
      {children}
    </span>
  );
}

export interface CardProps {
  /** The small uppercase head. Absent, the card is a plain box. */
  title?: string;
  /** Shown beside the title when above zero. */
  count?: number;
  /** A Pill, at the head's right. */
  pill?: ReactNode;
  /** A small button or link, at the head's right. */
  action?: ReactNode;
  /** For a screen reader, when the title is not enough. */
  label?: string;
  className?: string;
  children: ReactNode;
}

/** A boxed section of a column or a page: a head, then its body. */
export function Card({ title, count, pill, action, label, className, children }: CardProps): ReactElement {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-label={label ?? title}>
      {(title || action || pill) && (
        <div className="card-head">
          {title && (
            <span className="card-title">
              {title}
              {count !== undefined && count > 0 && <span className="card-count">{count}</span>}
            </span>
          )}
          {(pill || action) && (
            <span className="card-acts">
              {pill}
              {action}
            </span>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/** What a list or panel says when there is nothing in it: an answer, not a blank. */
export function Empty({ title, className, children }: { title?: string; className?: string; children: ReactNode }): ReactElement {
  return (
    <div className={`empty${className ? ` ${className}` : ""}`}>
      {title && <strong className="empty-title">{title}</strong>}
      <p className="empty-text">{children}</p>
    </div>
  );
}

/**
 * A small window fixed beside the thing that opened it: a colour picker, a
 * confirmation. Fixed to the viewport, so no card, drawer or modal clips
 * it, and placed below the anchor or above it when there is no room.
 */
export function useAnchoredPop(
  size: { width: number; height: number },
  /** What to measure, when the wrap has no box of its own (a menu renders it as `display: contents`). */
  anchor?: React.RefObject<HTMLElement | null>,
): {
  at: { top: number; left: number } | null;
  open: boolean;
  toggle: () => void;
  close: () => void;
  wrap: React.RefObject<HTMLDivElement | null>;
  pop: React.RefObject<HTMLDivElement | null>;
} {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const open = at !== null;
  const close = (): void => setAt(null);
  const toggle = (): void => {
    if (at) {
      setAt(null);
      return;
    }
    const box = (anchor?.current ?? wrap.current)?.getBoundingClientRect();
    if (!box) return;
    const below = box.bottom + 6 + size.height <= window.innerHeight;
    setAt({
      top: below ? box.bottom + 6 : Math.max(8, box.top - 6 - size.height),
      left: Math.min(box.left, Math.max(8, window.innerWidth - size.width - 8)),
    });
  };
  // It closes on a press outside it, on Escape, or when the page moves under it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !wrap.current?.contains(t)) setAt(null);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setAt(null);
      }
    };
    const moved = (e: Event): void => {
      if (!pop.current?.contains(e.target as Node)) setAt(null);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open]);
  return { at, open, toggle, close, wrap, pop };
}

export interface ConfirmButtonProps {
  /** The button as it sits in the page. */
  label: string;
  /** The line in the window: what goes, and that it cannot be undone. */
  text: string;
  /** The button in the window; the label again when absent. */
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  /** "menuitem" when the button is one item of a menu. */
  role?: string;
}

/**
 * Something that cannot be undone asks once, right where it was pressed:
 * a small window beside the button with one line and the choice. Not a
 * dialog in the middle of the page, and not a button that changes its
 * words on the first press. Every delete on the site uses this.
 */
export function ConfirmButton({ label, text, confirmLabel, onConfirm, className = "btn btn--sm btn--danger-ghost", disabled = false, title, role }: ConfirmButtonProps): ReactElement {
  // Measured from the button: inside a menu the wrap is `display: contents`
  // and has no box, which put the window at the top left of the page.
  const button = useRef<HTMLButtonElement>(null);
  const { at, open, toggle, close, wrap, pop } = useAnchoredPop({ width: 280, height: 96 }, button);
  return (
    <div className="confirm-wrap" ref={wrap}>
      <button ref={button} type="button" role={role} className={className} disabled={disabled} title={title} aria-expanded={open} onClick={toggle}>
        {label}
      </button>
      {createPortal(
        <AnimatePresence>
          {at && (
            <m.div
              className="kos-pop confirm-pop"
              ref={pop}
              role="alertdialog"
              aria-label={label}
              style={{ top: at.top, left: at.left }}
              initial={{ opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: -3 }}
              transition={ease}
            >
              <p className="confirm-text">{text}</p>
              <div className="confirm-acts">
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  autoFocus
                  onClick={() => {
                    close();
                    onConfirm();
                  }}
                >
                  {confirmLabel ?? label}
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={close}>
                  Cancel
                </button>
              </div>
            </m.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
