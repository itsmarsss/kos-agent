import { useMemo, useState, type ReactElement } from "react";
import { m } from "motion/react";

import type { PageSummary, Project } from "./api.js";
import { card, stagger } from "./motion.js";
import { hrefFor } from "./routes.js";

/**
 * Projects as cards, grouped by status.
 *
 * A table is the right shape when you are scanning one column across many
 * rows. Projects are not that: you come here to get into one, and its pages
 * are the way in. The list made you read a name, click a row, and find the
 * page in a drawer; the card puts the pages on the card.
 */

export interface ProjectsPageProps {
  projects: Project[];
  pagesByProject: Map<string, PageSummary[]>;
  onInspect: (project: Project, pages: PageSummary[]) => void;
}

/** Active first: dormant and archived are things you look up, not scan. */
const ORDER = ["active", "born", "dormant", "done", "archived"];

function relative(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ProjectsPage({
  projects,
  pagesByProject,
  onInspect,
}: ProjectsPageProps): ReactElement {
  const [query, setQuery] = useState("");

  /** A card's own action: its page if it has one, otherwise its details. */
  const open = (project: Project, pages: PageSummary[]): void => {
    const page = pages[0];
    if (page) window.location.hash = hrefFor({ name: "page", id: page.id });
    else onInspect(project, pages);
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? projects.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.slug.toLowerCase().includes(q) ||
            p.type.toLowerCase().includes(q),
        )
      : projects;

    const byStatus = new Map<string, Project[]>();
    for (const p of matched) {
      byStatus.set(p.status, [...(byStatus.get(p.status) ?? []), p]);
    }
    return [...byStatus.entries()].sort(
      (a, b) =>
        (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99),
    );
  }, [projects, query]);

  return (
    <div className="projects">
      <div className="projects-head">
        <h1>Projects</h1>
        <input
          className="chats-search projects-search"
          value={query}
          placeholder="Search projects…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {projects.length === 0 && (
        <p className="hint">
          Nothing yet. Ask KOS to build something and it will show up here.
        </p>
      )}
      {projects.length > 0 && groups.length === 0 && (
        <p className="hint">Nothing matches.</p>
      )}

      {groups.map(([status, items]) => (
        <section key={status} className="projects-group">
          <h2>
            {status}
            <span className="projects-count">{items.length}</span>
          </h2>
          <m.div
            className="card-grid"
            variants={stagger}
            initial="hidden"
            animate="show"
          >
            {items.map((p) => {
              const pages = pagesByProject.get(p.slug) ?? [];
              return (
                <m.div
                  key={p.slug}
                  variants={card}
                  whileHover={{ y: -2 }}
                  className="card project-card"
                  role="button"
                  tabIndex={0}
                  // The card looked clickable and was not: only the chips and
                  // Details did anything. Clicking it opens the project's page
                  // when it has one, and its details when it does not.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    open(p, pages);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    open(p, pages);
                  }}
                >
                  <div className="card-top">
                    <span className="card-name">{p.name}</span>
                    <span className={`dot dot--${p.status}`} />
                  </div>
                  {p.description && (
                    <p className="project-desc">{p.description}</p>
                  )}

                  {pages.length > 0 ? (
                    <div className="project-pages">
                      {pages.map((pg) => (
                        <a
                          key={pg.id}
                          className="ops-page-chip"
                          href={hrefFor({ name: "page", id: pg.id })}
                        >
                          {pg.title}
                        </a>
                      ))}
                    </div>
                  ) : (
                    <span className="project-nopages">No pages yet</span>
                  )}

                  <div className="card-foot">
                    <span>{p.type}</span>
                    <button
                      type="button"
                      className="link project-more"
                      onClick={() => onInspect(p, pages)}
                    >
                      Details
                    </button>
                    <span>{relative(p.lastTouchedAt)}</span>
                  </div>
                </m.div>
              );
            })}
          </m.div>
        </section>
      ))}
    </div>
  );
}
