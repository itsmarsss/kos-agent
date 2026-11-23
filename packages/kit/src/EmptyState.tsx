import type { ReactElement, ReactNode } from "react";

import { Skeleton } from "./kit.js";

/**
 * What a list says when there is nothing in it: an answer, not a blank.
 *
 * - `page`: a page's list, in a dashed box with a title.
 * - `inline`: one quiet line, inside a card or a rail that is already the box.
 * - `row`: a table's one row, across its columns.
 *
 * With `query` it says nothing matched, in the same words on every page, and
 * offers the one way back: Clear filters. A page with nothing at all says so
 * in its own words (`title`, `children`); a search that found nothing never
 * does, so "Nothing has happened yet" is never the answer to a typo.
 *
 * With `loading` it is where the list will be while it is read: skeletons
 * in the variant's shape, never "No projects yet" before the first answer.
 */
export type EmptyStateProps = {
  title?: string;
  /** The list has not been read yet: draw where it will be, not that it is empty. */
  loading?: boolean;
  /**
   * What the list's items are, for the skeleton to take their shape: rows
   * stacked (the default), or cards in the 280px grid Projects and Blobs
   * lay out in. With `itemHeight`, each is that tall, so nothing moves when
   * the items arrive.
   */
  shape?: "rows" | "cards";
  itemHeight?: number;
  /** What was searched for: "claims", "projects". Given, the words are the no-match ones. */
  query?: { noun: string; onClear?: () => void };
  className?: string;
  children?: ReactNode;
} & ({ variant?: "page" | "inline" } | { variant: "row"; columns: number });

/** The words a search that found nothing says, on every page. */
export function noMatchWords(noun: string): { title: string; line: string } {
  return { title: "Nothing matches", line: `No ${noun} match these words and filters.` };
}

/** What a list shows: where it will be, that it is empty, that nothing matched, or its rows. */
export type ListState = "loading" | "empty" | "no-match" | "rows";

/**
 * Which of the four a list is in, from whether it has been read, how many it
 * holds and how many pass its search and filters. Empty is said only once
 * the list has been read; before that it is loading, whatever it holds.
 */
export function listState(read: boolean, total: number, shown: number = total): ListState {
  if (!read) return "loading";
  if (total === 0) return "empty";
  return shown === 0 ? "no-match" : "rows";
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  const { title, query, className, children } = props;
  const variant = props.variant ?? "page";
  if (props.loading) return <Loading {...props} />;
  const words = query ? noMatchWords(query.noun) : undefined;
  const clear = query?.onClear ? (
    <button type="button" className="btn btn--sm empty-clear" onClick={query.onClear}>
      Clear filters
    </button>
  ) : null;
  const cls = (base: string): string => `${base}${className ? ` ${className}` : ""}`;
  if (variant === "page") {
    const head = words?.title ?? title;
    return (
      <div className={cls("empty")}>
        {head && <strong className="empty-title">{head}</strong>}
        <p className="empty-text">{words?.line ?? children}</p>
        {clear}
      </div>
    );
  }
  const line = (
    <>
      <span>{words?.line ?? children}</span>
      {clear}
    </>
  );
  if (props.variant === "row") {
    return (
      <tr className={cls("empty-row")}>
        <td colSpan={props.columns}>
          <span className="empty-line">{line}</span>
        </td>
      </tr>
    );
  }
  return <p className={cls("empty-line")}>{line}</p>;
}

/** The skeleton an EmptyState draws while its list is read: a few rows, a line, or a table's rows. */
function Loading(props: EmptyStateProps): ReactElement {
  const cls = `list-loading${props.className ? ` ${props.className}` : ""}`;
  if (props.variant === "row") {
    // A cell per column, so no bar runs across a column's line.
    const cells = Array.from({ length: props.columns }, (_, c) => c);
    return (
      <>
        {[0, 1, 2].map((i) => (
          <tr key={i} className="list-loading-row" {...(i === 0 ? { role: "status", "aria-label": "Loading" } : { "aria-hidden": "true" })}>
            {cells.map((c) => (
              <td key={c}>
                <Skeleton width={`${(c === 0 ? 70 : 55) - i * 10}%`} height={12} />
              </td>
            ))}
          </tr>
        ))}
      </>
    );
  }
  if (props.variant === "inline") {
    return (
      <p className={cls} role="status" aria-label="Loading">
        <Skeleton width="60%" height={12} />
      </p>
    );
  }
  const cards = props.shape === "cards";
  return (
    <div className={`${cls}${cards ? " list-loading--cards" : ""}`} role="status" aria-label="Loading">
      {Array.from({ length: cards ? 6 : 3 }, (_, i) => (
        <Skeleton key={i} height={props.itemHeight ?? (cards ? 117 : 44)} radius="var(--r-md)" />
      ))}
    </div>
  );
}
