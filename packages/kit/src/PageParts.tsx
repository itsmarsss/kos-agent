import { useImperativeHandle, useRef, type FocusEvent, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";

import { CloseIcon, SearchIcon } from "./icons.js";
import { Count, IconButton } from "./kit.js";

/**
 * The head over a group of rows, or a section of a form: its name at the
 * title's size and weight, how many when it counts, an action at its right.
 * Inbox's Approvals, Memory's Everywhere, Projects' KOS's own, a sheet's
 * "When it runs" are this one head, not four.
 */
export function GroupHead({ title, count, action, as: Tag = "h2", id }: { title: ReactNode; count?: number; action?: ReactNode; as?: "h2" | "h3"; id?: string }): ReactElement {
  return (
    <div className="group-head">
      <Tag className="group-title" id={id}>
        {title}
        {count !== undefined && <Count n={count} />}
      </Tag>
      {action && <span className="group-action">{action}</span>}
    </div>
  );
}

/**
 * A search box: the glass at its start, an × to clear once there are words,
 * Escape clears too. Its placeholder is "Search <what>", the one pattern,
 * so a page names only what it holds.
 */
export function SearchField({
  value,
  onChange,
  noun,
  label,
  className,
  autoFocus,
  inputRef,
  onKeyDown,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  noun: string;
  label?: string;
  className?: string;
  autoFocus?: boolean;
  /** The field itself, for a page that focuses it on a key (Settings' /). */
  inputRef?: Ref<HTMLInputElement | null>;
  /** Keys a page reads first (arrows through results); Escape still clears unless it stops it. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(inputRef, () => input.current!, []);
  return (
    <label className={`search-field${className ? ` ${className}` : ""}`}>
      <SearchIcon />
      <input
        ref={input}
        className="kos-input search-field-input"
        type="search"
        value={value}
        placeholder={`Search ${noun}`}
        aria-label={label ?? `Search ${noun}`}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        {...(onBlur ? { onBlur } : {})}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="search-field-clear"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <CloseIcon size={12} title="" />
        </button>
      )}
    </label>
  );
}

/**
 * What a page says when what it was asked to open is not there: a project,
 * an artifact, a blob, by the name it was asked for, and the way back. Never
 * the server's own words, and never a skeleton waiting for what will not come.
 */
export function NotFound({ what, name, back }: { what: string; name: string; back?: { label: string; href?: string; onClick?: () => void } }): ReactElement {
  return (
    <div className="not-found" role="status">
      <strong className="empty-title">No {what} called “{name}”</strong>
      <p className="empty-text">It may have been renamed, moved or deleted.</p>
      {back &&
        (back.href ? (
          <a className="btn btn--sm" href={back.href}>
            {back.label}
          </a>
        ) : (
          <button type="button" className="btn btn--sm" onClick={back.onClick}>
            {back.label}
          </button>
        ))}
    </div>
  );
}

/** One column of a table's head: its words, and which side its figures sit. */
export interface Column {
  label: ReactNode;
  align?: "start" | "end";
  /** A CSS width, for a column that should not grow: "6rem". */
  width?: string;
}

/** A table's head, in the one style: small, quiet, the columns named. */
export function TableHead({ columns }: { columns: readonly Column[] }): ReactElement {
  return (
    <thead className="table-head">
      <tr>
        {columns.map((c, i) => (
          <th key={i} scope="col" className={c.align === "end" ? "is-end" : undefined} style={c.width ? { width: c.width } : undefined}>
            {c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/**
 * The same head over a list drawn as rows rather than a table (the Inbox's
 * Decided): the columns' names in the one style, each as wide as its column.
 */
export function ListHead({ columns, className }: { columns: readonly Column[]; className?: string }): ReactElement {
  return (
    <div className={`table-head table-head--list${className ? ` ${className}` : ""}`} aria-hidden="true">
      {columns.map((c, i) => (
        <span key={i} className={`table-head-cell${c.align === "end" ? " is-end" : ""}`} style={c.width ? { flex: `none`, width: c.width } : { flex: 1, minWidth: 0 }}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

/** A group's head inside a table (Today, Yours): a GroupHead across its columns. */
export function TableGroup({ title, count, columns }: { title: ReactNode; count?: number; columns: number }): ReactElement {
  return (
    <tr className="table-group">
      <th colSpan={columns} scope="colgroup">
        {/* Under the page's h1 with nothing between: a level down, not two. */}
        <GroupHead title={title} {...(count !== undefined ? { count } : {})} />
      </th>
    </tr>
  );
}

/**
 * The head of a pane beside a chat, a project's or a blob's alike: its mark
 * (a project's tile, a blob's face), its name over its kind, its state at the
 * right, what it is for under them, then whatever the pane adds (how much it
 * holds, its buttons). Over the chat, as a drawer, it has an × to close.
 */
export function PaneHead({ mark, title, sub, pill, desc, onClose, children }: { mark: ReactNode; title: string; sub?: ReactNode; pill?: ReactNode; desc?: ReactNode; onClose?: () => void; children?: ReactNode }): ReactElement {
  return (
    <header className="pane-head">
      <div className="pane-head-top">
        <span className="pane-head-mark">{mark}</span>
        <div className="pane-head-titles">
          <h2>{title}</h2>
          {sub && <span className="pane-head-sub">{sub}</span>}
        </div>
        {pill}
        {/* A pane drawn over the chat, as on a phone, shuts here as a sheet does. */}
        {onClose && (
          <IconButton className="pane-head-close" label="Close" title="Close" onClick={onClose}>
            <CloseIcon size={14} title="" />
          </IconButton>
        )}
      </div>
      {desc && <p className="pane-head-desc">{desc}</p>}
      {children}
    </header>
  );
}
