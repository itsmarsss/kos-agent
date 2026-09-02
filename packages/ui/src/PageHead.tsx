import { type ReactElement, type ReactNode } from "react";

/**
 * The top of a page: what it is, then what you can do on it.
 *
 * One component because Schedule, History, Knowledge and Agents each grew
 * their own header, with different type sizes, different search boxes and
 * the primary action in a different place on each. Moving between them read
 * as moving between four applications.
 *
 * Search sits next to the actions rather than above them, and the primary
 * action is last, so the eye lands on it after reading the row.
 */
export function PageHead({
  title,
  subtitle,
  search,
  actions,
}: {
  title: string;
  subtitle?: string;
  /** A search box, where the page has something worth searching. */
  search?: ReactNode;
  /** Buttons. The primary one goes last. */
  actions?: ReactNode;
}): ReactElement {
  return (
    <header className="list-head">
      <div className="list-head-titles">
        <h1 className="list-title">{title}</h1>
        {subtitle && <p className="list-sub">{subtitle}</p>}
      </div>
      {(search || actions) && (
        <div className="list-head-tools">
          {search}
          {actions}
        </div>
      )}
    </header>
  );
}
