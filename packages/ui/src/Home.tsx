import { useEffect, useState, type ReactElement } from "react";

import { api, type PageSummary, type Project } from "./api.js";
import { hrefFor } from "./routes.js";

/**
 * The workspace home: what you own, not what the system is doing. Each project
 * is a card carrying the headline number from its own page, so the landing
 * screen answers "how much have I spent" without a click. Operational detail
 * lives one level down, because it is rarely what you came for.
 */

export interface HomeProps {
  projects: Project[];
  pagesByProject: Map<string, PageSummary[]>;
  onInspect: (project: Project, pages: PageSummary[]) => void;
}

interface Headline {
  label: string;
  value: string;
}

/**
 * Pull the first stat off a project's page. The page already declares what
 * matters about the project, so the card reuses that rather than inventing a
 * second definition of "the important number".
 */
async function headlineFor(pageId: string): Promise<Headline | null> {
  try {
    const payload = await api.page(pageId);
    const widgets = payload.spec.widgets ?? [];
    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i] as { type: string; label?: string };
      if (w.type !== "stat") continue;
      const row = payload.data[i]?.[0];
      if (!row) continue;
      const value = Object.values(row)[0];
      if (value === null || value === undefined) continue;
      return { label: w.label ?? "", value: String(value) };
    }
  } catch {
    // A card without its number is still a usable card.
  }
  return null;
}

function relative(ts: number): string {
  const secs = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function Home({
  projects,
  pagesByProject,
  onInspect,
}: HomeProps): ReactElement {
  const [headlines, setHeadlines] = useState<Record<string, Headline | null>>({});

  useEffect(() => {
    let cancelled = false;
    const wanted = projects
      .map((p) => ({ slug: p.slug, page: pagesByProject.get(p.slug)?.[0] }))
      .filter((x): x is { slug: string; page: PageSummary } => Boolean(x.page));

    void Promise.all(
      wanted.map(async (w) => [w.slug, await headlineFor(w.page.id)] as const),
    ).then((entries) => {
      if (!cancelled) setHeadlines(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [projects, pagesByProject]);

  if (projects.length === 0) {
    return (
      <div className="home-empty">
        <h1>Nothing here yet</h1>
        <p>Ask KOS to build something: a budget, a reading list, a training log.</p>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home-head">
        <h1>Your workspace</h1>
        <span className="home-count">
          {projects.length} project{projects.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="card-grid">
        {[...projects]
          .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
          .map((project) => {
          const pages = pagesByProject.get(project.slug) ?? [];
          const page = pages[0];
          const headline = headlines[project.slug];
          const body = (
            <>
              <div className="card-top">
                <span className="card-name">{project.name}</span>
                <span className={`dot dot--${project.status}`} title={project.status} />
              </div>
              {headline ? (
                <div className="card-figure">
                  <span className="card-value">{headline.value}</span>
                  <span className="card-label">{headline.label}</span>
                </div>
              ) : (
                <div className="card-figure card-figure--none">
                  <span className="card-label">{project.type}</span>
                </div>
              )}
              <div className="card-foot">
                <span>{relative(project.lastTouchedAt)}</span>
                {pages.length > 1 && <span>{pages.length} pages</span>}
              </div>
            </>
          );

          return page ? (
            <a key={project.slug} className="card card--link" href={hrefFor({ name: "page", id: page.id })}>
              {body}
            </a>
          ) : (
            <button
              key={project.slug}
              type="button"
              className="card"
              onClick={() => onInspect(project, pages)}
            >
              {body}
              <span className="card-hint">No page yet — ask KOS to build one</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
