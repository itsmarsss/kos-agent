import type { ReactElement, ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease, SheetHead, spring, useDismiss } from "@kos/kit";


/**
 * A panel that slides in from the right.
 *
 * The house style for anything with more than a field or two in it: a build
 * log, a project, a schedule. A centred dialog covers the list you opened it
 * from, and going from one row to the next means closing and reopening; a
 * drawer leaves the list in place beside it.
 *
 * Modals are kept for the small, blocking questions -- rename this, are you
 * sure -- where covering the page for a moment is the point. Both have the
 * one head (an × to close) and the one foot (`SheetFoot`).
 */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  /** A line under the title: what this is, or which one of them. */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** Its `SheetFoot`, pinned to the bottom so the actions do not scroll away. */
  footer?: ReactNode;
  /** For content that needs the room, like a form beside its explanation. */
  wide?: boolean;
}): ReactElement {
  useDismiss(open, onClose, { away: false, scroll: false, resize: false, escape: "dialog" });

  return (
    <AnimatePresence>
      {open && (
        <m.div
          className="drawer-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={ease}
          onClick={onClose}
        >
          <m.aside
            className={`drawer ${wide ? "drawer--wide" : ""}`}
            role="dialog"
            aria-label={title}
            initial={{ x: 28, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 28, opacity: 0 }}
            transition={spring}
            onClick={(e) => e.stopPropagation()}
          >
            <SheetHead title={title} subtitle={subtitle} onClose={onClose} />
            <div className="drawer-body">{children}</div>
            {footer}
          </m.aside>
        </m.div>
      )}
    </AnimatePresence>
  );
}
