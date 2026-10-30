import { useState, type ReactElement, type ReactNode } from "react";

/** One setting: a label, the control, and why you would touch it. */
export function Field({
  label,
  hint,
  children,
  badge,
  row,
  meta,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  badge?: ReactNode;
  /** A line under the hint, in the words column: where it came from, say. */
  meta?: ReactNode;
  /**
   * The control beside the words rather than under them. For a list of
   * things with a switch each: stacked, every item was a name, then a
   * checkbox on a line of its own, then its description, and four of them
   * read as twelve lines.
   */
  row?: boolean;
}): ReactElement {
  // A row's words open on click: a skill's description can run to a
  // paragraph of triggers, and fourteen of those is a wall.
  const [open, setOpen] = useState(false);
  if (row) {
    return (
      <div className={`set-field set-field--row${open ? " is-open" : ""}`}>
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
  // The kit's field, so a setting reads like a field anywhere else.
  return (
    <div className="kos-field set-field">
      <span className="kos-field-label">
        {label}
        {badge}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {meta}
    </div>
  );
}
