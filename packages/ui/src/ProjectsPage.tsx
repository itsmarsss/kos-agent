import { useEffect, useMemo, useState, type ReactElement } from "react";
import { m } from "motion/react";

import { api, type Conversation, type PageSummary, type Project, type SiteInfo } from "./api.js";
import { FileIcon } from "./FileIcon.js";
import { Pill } from "./kit.js";
import { card, stagger } from "./motion.js";
import { NewProjectDialog } from "./NewProjectDialog.js";
import { markStyle } from "./ProjectMark.js";
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
  /** Every conversation, so a card can link to the project's chat and count its agents. */
  conversations: Conversation[];
  /** The card itself: the project's workspace. */
  onOpen: (slug: string) => void;
  /** The drawer, for status and metadata. */
  onInspect: (project: Project, pages: PageSummary[]) => void;
  /** An empty project of the owner's own, with nothing in it until they or KOS put something there. */
  onCreate?: (input: { name: string; type: string }) => Promise<void>;
}

/** A browser window, marking a chip as something that opens a running site. */
function SiteGlyph(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
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
  conversations,
  onOpen,
  onInspect,
  onCreate,
}: ProjectsPageProps): ReactElement {
  const [query, setQuery] = useState("");
  const [making, setMaking] = useState(false);
  const agentsOf = (slug: string): number =>
    conversations.filter((c) => c.kind === "chat" && c.projectSlug === slug && !c.archived).length;
  // Sites live under their project, so they belong on its card rather than in
  // a tab of their own: the tracker, its pages and its site are one thing.
  const [sites, setSites] = useState<{ base: string | null; sites: SiteInfo[] }>({
    base: null,
    sites: [],
  });

  useEffect(() => {
    let cancelled = false;
    void api
      .sites()
      .then((r) => {
        if (!cancelled) setSites(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const sitesFor = (slug: string): SiteInfo[] =>
    sites.sites.filter((s) => s.project === slug);

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
        {onCreate && (
          <button type="button" className="btn btn--primary" onClick={() => setMaking(true)}>
            New project
          </button>
        )}
      </div>

      {onCreate && <NewProjectDialog open={making} onClose={() => setMaking(false)} onCreate={onCreate} />}

      {projects.length === 0 && (
        <p className="hint">
          Nothing yet. Ask KOS to build something, or make an empty project above, and it will show up here.
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
                  // A card is the project, so clicking it opens the project's
                  // workspace. Its pages are the chips on it, each its own
                  // link; sending the click to the first page made the card a
                  // lottery, and sending it to a drawer made it a summary.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    onOpen(p.slug);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onOpen(p.slug);
                  }}
                >
                  <div className="project-card-head">
                    {/* The project's mark in its colour, as its own page wears it. */}
                    <span className="hero-mark hero-mark--sm" aria-hidden="true" style={markStyle(p.slug, p.colour)}>
                      <FileIcon name={p.slug} kind="dir" size={18} />
                    </span>
                    <div className="project-card-titles">
                      <span className="card-name">{p.name}</span>
                      <span className="project-card-sub">
                        {p.module ? `${p.type} · from ${p.module}` : p.type} · {relative(p.lastTouchedAt)}
                      </span>
                    </div>
                    <Pill tone={p.status === "active" ? "ok" : p.status === "archived" || p.status === "done" ? "muted" : "warn"}>{p.status}</Pill>
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

                  {sitesFor(p.slug).length > 0 && (
                    <div className="project-sites">
                      {sitesFor(p.slug).map((site) => (
                        <a
                          key={site.path}
                          className="site-chip"
                          // A new tab, and no referrer: the site is served on
                          // its own origin precisely so it has none of this
                          // page's authority, and opening it in place would
                          // hand back some of what that separation is for.
                          href={
                            sites.base && site.hasIndex
                              ? `${sites.base}/${encodeURIComponent(site.project)}/${encodeURIComponent(site.name)}/`
                              : hrefFor({ name: "files", path: site.path })
                          }
                          {...(sites.base && site.hasIndex
                            ? { target: "_blank", rel: "noreferrer noopener" }
                            : {})}
                          title={
                            site.hasIndex
                              ? `Open ${site.name}`
                              : `${site.name} has no index.html yet`
                          }
                        >
                          <SiteGlyph />
                          {site.name}
                        </a>
                      ))}
                    </div>
                  )}

                  <div className="card-foot project-card-foot">
                    <span className="hint">{agentsOf(p.slug) > 0 ? `${agentsOf(p.slug)} ${agentsOf(p.slug) === 1 ? "agent" : "agents"}` : "no agents"}</span>
                    <span className="card-acts">
                      {/* The project's chat is where its work happens. */}
                      <a className="btn btn--sm btn--primary" href={hrefFor({ name: "project", slug: p.slug })}>
                        Chat
                      </a>
                      <button type="button" className="btn btn--sm" onClick={() => onInspect(p, pages)}>
                        Details
                      </button>
                    </span>
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
