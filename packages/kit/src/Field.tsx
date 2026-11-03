import type { ReactElement, ReactNode } from "react";

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
  className?: string;
  children: ReactNode;
}

/**
 * One labelled control: the label, the control, then a hint or an error.
 * Marked with its label (data-field) so a search can scroll to it.
 */
export function Field({ label, required = false, hint, error, group = false, badge, meta, className, children }: FieldProps): ReactElement {
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
