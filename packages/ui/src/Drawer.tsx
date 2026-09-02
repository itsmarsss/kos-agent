import { useEffect, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease, spring } from "./motion.js";

/**
 * A panel that slides in from the right.
 *
 * The house style for anything with more than a field or two in it: a build
 * log, a project, a schedule. A centred dialog covers the list you opened it
 * from, and going from one row to the next means closing and reopening; a
 * drawer leaves the list in place beside it.
 *
 * Modals are kept for the small, blocking questions -- rename this, are you
 * sure -- where covering the page for a moment is the point.
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
  /** Actions, pinned to the bottom so they do not scroll away. */
  footer?: ReactNode;
  /** For content that needs the room, like a form beside its explanation. */
  wide?: boolean;
}): ReactElement {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose]);

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
            <header className="drawer-head">
              <div className="drawer-titles">
                <h2 className="drawer-title">{title}</h2>
                {subtitle && <p className="drawer-sub">{subtitle}</p>}
              </div>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </header>
            <div className="drawer-body">{children}</div>
            {footer && <footer className="drawer-foot">{footer}</footer>}
          </m.aside>
        </m.div>
      )}
    </AnimatePresence>
  );
}
