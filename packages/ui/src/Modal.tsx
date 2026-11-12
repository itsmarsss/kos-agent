import { useRef, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { CloseIcon, ease, IconButton, spring, useDismiss, useFocusTrap } from "@kos/kit";


/**
 * A centred dialog. Configuration belongs here rather than expanded inline:
 * a form that pushes the conversation down the page makes you lose your place
 * in the thing you were reading in order to change a setting about it.
 */
export function Modal({
  open,
  title,
  onClose,
  size,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** A short form (a name, a choice of place) in a narrower box than a dialog's usual. */
  size?: "sm";
  children: ReactNode;
}): ReactElement {
  useDismiss(open, onClose, { away: false, scroll: false, resize: false, escape: "dialog" });
  // The tab key stays in the dialog, and the focus goes back to what opened it.
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useFocusTrap(box, open, body);

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
            ref={box}
            className={size ? `modal modal--${size}` : "modal"}
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
              <IconButton label="Close" onClick={onClose}>
                <CloseIcon title="" />
              </IconButton>
            </header>
            <div className="modal-body" ref={body}>
              {children}
            </div>
          </m.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
