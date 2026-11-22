import { useRef, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease, SheetHead, spring, useFocusTrap } from "@kos/kit";


/**
 * A panel that slides in from the right.
 *
 * The house style for anything with more than a field or two in it: a build
 * log, a project, a schedule, a run. A centred dialog covers the list you
 * opened it from, and going from one row to the next means closing and
 * reopening; a drawer leaves the list in place beside it.
 *
 * Modals are kept for the small, blocking questions -- rename this, are you
 * sure -- where covering the page for a moment is the point. Both have the
 * one head (an × to close), the one foot (`SheetFoot`) and the one focus:
 * it goes in as the sheet opens, the tab key stays inside, Escape shuts it
 * and the focus goes back to what opened it (`useFocusTrap`).
 */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
  className,
}: {
  open: boolean;
  title: string;
  /** A line under the title: what this is, or which one of them. */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Its `SheetFoot`, pinned to the bottom so the actions do not scroll away. */
  footer?: ReactNode;
  /** For content that needs the room, like a form beside its explanation. */
  wide?: boolean;
  /** A class of its own on the panel, for what its content lays out. */
  className?: string;
}): ReactElement {
  const box = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useFocusTrap(box, open, { start: body, onEscape: onClose });

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
            ref={box}
            className={["drawer", wide && "drawer--wide", className].filter(Boolean).join(" ")}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={spring}
            onClick={(e) => e.stopPropagation()}
          >
            <SheetHead title={title} subtitle={subtitle} onClose={onClose} />
            <div className="drawer-body" ref={body}>
              {children}
            </div>
            {footer}
          </m.aside>
        </m.div>
      )}
    </AnimatePresence>
  );
}
