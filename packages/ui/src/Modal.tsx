import { useRef, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import { ease, float, SheetHead, useFocusTrap } from "@kos/kit";


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
  footer,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** A short form (a name, a choice of place) in a narrower box than a dialog's usual. */
  size?: "sm";
  /** Its `SheetFoot`, under the body, which scrolls above it. */
  footer?: ReactNode;
  children: ReactNode;
}): ReactElement {
  // The focus goes in, the tab key stays in, Escape shuts it, and the focus goes back to what opened it.
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useFocusTrap(box, open, { start: body, onEscape: onClose });

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
            /* As everything that floats: a fade and a scale from 0.98 on the one ease. */
            variants={float}
            initial="hidden"
            animate="show"
            exit="hidden"
            transition={ease}
          >
            <SheetHead title={title} onClose={onClose} />
            <div className="modal-body" ref={body}>
              {children}
            </div>
            {footer}
          </m.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
