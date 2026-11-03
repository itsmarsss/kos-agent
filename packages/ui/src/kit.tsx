import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";

import { ease } from "@kos/kit";

import { useDismiss } from "./useDismiss.js";

/**
 * The small parts every page is built from, so they are built the same way.
 *
 * Before this, each page grew its own: five label styles, three kinds of
 * section head, chips in four shapes, and an empty state per page. Moving
 * between pages read as moving between applications. These are the one
 * version of each: docs/ui.md says when to use which, and
 * docs/components.md where each app keeps it.
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
  /** Beside the label: what it is set to, say, as a Tag. */
  badge?: ReactNode;
  /** A line under the hint: where it came from, say. */
  meta?: ReactNode;
  /**
   * The control beside the words rather than under them. For a list of
   * things with a switch each: stacked, every item was a name, then a
   * checkbox on a line of its own, then its description, and four of them
   * read as twelve lines.
   */
  row?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * One labelled control: the label, the control, then a hint or an error.
 * Marked with its label (data-field) so a search can scroll to it.
 */
export function Field({ label, required = false, hint, error, group = false, badge, meta, row = false, className, children }: FieldProps): ReactElement {
  if (row) return <FieldRow label={label} hint={hint} badge={badge} meta={meta} className={className}>{children}</FieldRow>;
  const cls = `kos-field${className ? ` ${className}` : ""}`;
  const body = (
    <>
      <span className="kos-field-label">
        {label}
        {required && <Req />}
        {badge}
      </span>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
      {meta}
    </>
  );
  return group ? (
    <div className={cls} role="group" aria-label={label} data-field={label}>
      {body}
    </div>
  ) : (
    <label className={cls} data-field={label}>
      {body}
    </label>
  );
}

/** A field in a list: its words, which open on a click, and its control at the right. */
function FieldRow({ label, hint, badge, meta, className, children }: Pick<FieldProps, "label" | "hint" | "badge" | "meta" | "className" | "children">): ReactElement {
  // A row's words open on click: a skill's description can run to a
  // paragraph of triggers, and fourteen of those is a wall.
  const [open, setOpen] = useState(false);
  return (
    <div className={`set-field set-field--row${open ? " is-open" : ""}${className ? ` ${className}` : ""}`} data-field={label}>
      <button type="button" className="set-field-text" onClick={() => setOpen((v) => !v)} title={open ? "Less" : "More"}>
        <div className="set-label">
          <span>{label}</span>
          {badge}
        </div>
        {hint && <p className="set-hint">{hint}</p>}
        {open && meta}
      </button>
      <div className="set-field-control">{children}</div>
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
  useDismiss(open, close, { inside: [pop, wrap] });
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
export function ConfirmButton({ label, text, confirmLabel, onConfirm, className = "btn btn--sm btn--danger", disabled = false, title, role }: ConfirmButtonProps): ReactElement {
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
