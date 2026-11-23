import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

/** The mark on a required field's label: seen, not read; the control itself says it is required. */
export function Req(): ReactElement {
  return (
    <span className="field-req" title="Required" aria-hidden="true">
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

/** What a field's control is told, so a screen reader hears its name, whether it is required, and its hint or error. */
interface ControlAria {
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
  "aria-invalid"?: boolean;
}

/**
 * One labelled control: the label, the control, then a hint or an error.
 * Marked with its label (data-field) so a search can scroll to it.
 *
 * A lone control is tied to its parts: named by the label alone (not the
 * hint and the star the label wraps), described by the hint or the error,
 * required and invalid as the field is. A control that says these itself
 * keeps its own.
 */
export function Field({ label, required = false, hint, error, group = false, badge, meta, className, children }: FieldProps): ReactElement {
  const id = useId();
  const labelId = `${id}-label`;
  const noteId = `${id}-note`;
  const note = error ? "error" : hint ? "hint" : null;
  const cls = `kos-field${className ? ` ${className}` : ""}`;
  const aria: ControlAria = {
    "aria-labelledby": labelId,
    ...(note ? { "aria-describedby": noteId } : {}),
    ...(required ? { "aria-required": true } : {}),
    ...(error ? { "aria-invalid": true } : {}),
  };
  const control = !group && isValidElement<ControlAria>(children) ? cloneElement(children, { ...aria, ...definedAria(children.props) }) : children;
  const body = (
    <>
      <span className="kos-field-label" id={labelId}>
        {label}
        {required && <Req />}
        {badge}
      </span>
      {control}
      {note === "error" ? (
        <span className="field-error" id={noteId} role="alert">
          {error}
        </span>
      ) : note === "hint" ? (
        <span className="hint" id={noteId}>
          {hint}
        </span>
      ) : null}
      {meta}
    </>
  );
  return group ? (
    <div className={cls} role="group" aria-labelledby={labelId} {...(note ? { "aria-describedby": noteId } : {})} data-field={label}>
      {body}
    </div>
  ) : (
    <label className={cls} data-field={label}>
      {body}
    </label>
  );
}

/** The aria a control was given by hand, which wins over the field's. */
function definedAria(props: ControlAria): ControlAria {
  const out: ControlAria = {};
  for (const key of ["aria-labelledby", "aria-describedby", "aria-required", "aria-invalid"] as const) {
    if (props[key] !== undefined) (out as Record<string, unknown>)[key] = props[key];
  }
  return out;
}
