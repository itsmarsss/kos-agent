import type { ReactElement, ReactNode } from "react";

/** One titled block of the project panel: a small uppercase head, a count, an action, then its body. */
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
    <section className={`project-panel-section${className ? ` ${className}` : ""}`} {...rest}>
      <div className="ops-section-head">
        <h2>
          {title}
          {count !== undefined && count > 0 && <span className="project-panel-count">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
