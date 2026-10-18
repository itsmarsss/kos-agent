import type { ReactElement, ReactNode } from "react";

/** One titled block of a panel: the kit's card, with a small uppercase head, a count, an action, then its body. */
export function PanelSection({
  title,
  count,
  action,
  className,
  children,
  ...rest
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "title" | "className" | "children">): ReactElement {
  return (
    <section className={`card project-panel-section${className ? ` ${className}` : ""}`} {...rest}>
      <div className="card-head">
        <h2 className="card-title">
          {title}
          {count !== undefined && count > 0 && <span className="card-count">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
