import type { ReactElement, ReactNode } from "react";

import { CloseIcon } from "./icons.js";
import { IconButton } from "./kit.js";

/**
 * The head and foot every sheet has, a drawer from the side and a dialog in
 * the middle alike: the title (and a line under it) with an × to close at the
 * right; the actions at the foot, right-aligned, Cancel a secondary button
 * and the one thing the sheet is for last, in the accent. Something that
 * destroys sits apart at the far left, so it is never the button under the
 * hand that reached for Save.
 */
export function SheetHead({ title, subtitle, onClose, id }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; id?: string }): ReactElement {
  return (
    <header className="sheet-head">
      <div className="sheet-titles">
        <h2 className="sheet-title" id={id}>
          {title}
        </h2>
        {subtitle && <p className="sheet-sub">{subtitle}</p>}
      </div>
      <IconButton label="Close" onClick={onClose}>
        <CloseIcon title="" />
      </IconButton>
    </header>
  );
}

export interface SheetFootProps {
  /** The sheet's one action: a primary button, a submit for its form, last. */
  primary?: ReactNode;
  /** Closes the sheet without doing anything; absent, there is no Cancel (a sheet that only shows). */
  onCancel?: () => void;
  /** What Cancel says when it is not Cancel: Close, on a sheet with nothing to save. */
  cancelLabel?: string;
  /** Something that destroys (Delete, Wipe), set apart at the far left. */
  danger?: ReactNode;
  /** A quiet word before the buttons: where it goes, why it cannot yet. */
  note?: ReactNode;
}

export function SheetFoot({ primary, onCancel, cancelLabel = "Cancel", danger, note }: SheetFootProps): ReactElement {
  return (
    <footer className="sheet-foot">
      {danger && <span className="sheet-foot-danger">{danger}</span>}
      <span className="sheet-foot-note">{note}</span>
      {onCancel && (
        <button type="button" className="btn" onClick={onCancel}>
          {cancelLabel}
        </button>
      )}
      {primary}
    </footer>
  );
}
