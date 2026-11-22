import type { ReactElement, ReactNode } from "react";

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
 */
export type EmptyStateProps = {
  title?: string;
  /** What was searched for: "claims", "projects". Given, the words are the no-match ones. */
  query?: { noun: string; onClear?: () => void };
  className?: string;
  children?: ReactNode;
} & ({ variant?: "page" | "inline" } | { variant: "row"; columns: number });

/** The words a search that found nothing says, on every page. */
export function noMatchWords(noun: string): { title: string; line: string } {
  return { title: "Nothing matches", line: `No ${noun} match these words and filters.` };
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  const { title, query, className, children } = props;
  const variant = props.variant ?? "page";
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
