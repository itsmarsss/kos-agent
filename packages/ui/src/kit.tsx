import type { ReactElement, ReactNode } from "react";

/**
 * The small parts every page is built from, so they are built the same way.
 *
 * Before this, each page grew its own: five label styles, three kinds of
 * section head, chips in four shapes, and an empty state per page. Moving
 * between pages read as moving between applications. These are the one
 * version of each, and docs/ui.md says when to use which.
 */

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
  className?: string;
  children: ReactNode;
}

/** One labelled control: the label, the control, then a hint or an error. */
export function Field({ label, required = false, hint, error, group = false, className, children }: FieldProps): ReactElement {
  const cls = `kos-field${className ? ` ${className}` : ""}`;
  const body = (
    <>
      <span className="kos-field-label">
        {label}
        {required && <Req />}
      </span>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </>
  );
  return group ? (
    <div className={cls} role="group" aria-label={label}>
      {body}
    </div>
  ) : (
    <label className={cls}>{body}</label>
  );
}

export type Tone = "ok" | "warn" | "danger" | "accent" | "muted";

/** A state in a word: on, paused, failed. Coloured by what it means. */
export function Pill({ tone = "muted", title, children }: { tone?: Tone; title?: string; children: ReactNode }): ReactElement {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

/** A fact in a word or two: a tool family, a model class, a type. Not a button. */
export function Tag({ mono = false, title, children }: { mono?: boolean; title?: string; children: ReactNode }): ReactElement {
  return (
    <span className={`tag${mono ? " tag--mono" : ""}`} title={title}>
      {children}
    </span>
  );
}

export interface CardProps {
  /** The small uppercase head. Absent, the card is a plain box. */
  title?: string;
  /** Shown beside the title when above zero. */
  count?: number;
  /** A Pill, at the head's right. */
  pill?: ReactNode;
  /** A small button or link, at the head's right. */
  action?: ReactNode;
  /** For a screen reader, when the title is not enough. */
  label?: string;
  className?: string;
  children: ReactNode;
}

/** A boxed section of a column or a page: a head, then its body. */
export function Card({ title, count, pill, action, label, className, children }: CardProps): ReactElement {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-label={label ?? title}>
      {(title || action || pill) && (
        <div className="card-head">
          {title && (
            <span className="card-title">
              {title}
              {count !== undefined && count > 0 && <span className="card-count">{count}</span>}
            </span>
          )}
          {pill}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** What a list or panel says when there is nothing in it: an answer, not a blank. */
export function Empty({ title, className, children }: { title?: string; className?: string; children: ReactNode }): ReactElement {
  return (
    <div className={`empty${className ? ` ${className}` : ""}`}>
      {title && <strong className="empty-title">{title}</strong>}
      <p className="empty-text">{children}</p>
    </div>
  );
}
