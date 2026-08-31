import { useEffect, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease, spring } from "./motion.js";

/**
 * A centred dialog. Configuration belongs here rather than expanded inline:
 * a form that pushes the conversation down the page makes you lose your place
 * in the thing you were reading in order to change a setting about it.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
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
            className="modal-backdrop"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={ease}
          />
          {/*
            A static wrapper does the centring. Motion animates transform on
            the panel, which would otherwise overwrite a translate(-50%,-50%)
            and leave the dialog hanging off-centre.
          */}
          <div className="modal-wrap">
          <m.div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={spring}
          >
            <header className="modal-head">
              <strong>{title}</strong>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onClose}
                aria-label="Close"
              >
                ✕
              </button>
            </header>
            <div className="modal-body">{children}</div>
          </m.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
