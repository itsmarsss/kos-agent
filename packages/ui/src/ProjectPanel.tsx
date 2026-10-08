import { useCallback, useEffect, useState, type ReactElement } from "react";

import { api, type ProjectDetail } from "./api.js";
import { PanelSection } from "./PanelSection.js";
import { ProjectExplorer } from "./ProjectExplorer.js";
import { hrefFor } from "./routes.js";

/**
 * The column beside a project's threads: what the project has made and what
 * the owner has put in it. Its folder, browsed in place; pages; tables;
 * sites. The work happens in the thread next to it, and this is where the
 * work lands, so the two sit side by side rather than a page apart.
 */

export interface ProjectPanelProps {
  slug: string;
  onOpenPage: (id: string) => void;
  onOpenFile: (path: string) => void;
  /** Something changed that the rest of the dashboard lists too. */
  onChanged: () => void;
  onError: (message: string) => void;
  /** Slid shut: still mounted so it can slide open, but polling nothing. */
  hidden?: boolean;
}

/** How often the panel re-reads the project, so a page an agent made shows up. */
const POLL_MS = 5000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ProjectPanel({ slug, onOpenPage, onOpenFile, onChanged, onError, hidden = false }: ProjectPanelProps): ReactElement {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await api.projectDetail(slug));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [slug]);

  // Another project is another panel; a slid-shut one keeps what it shows,
  // so sliding it open again is the same content coming back, not
  // "Loading…" and then a pop.
  useEffect(() => {
    setDetail(null);
    setError(null);
  }, [slug]);

  useEffect(() => {
    if (hidden) return;
    void load();
    // Nothing is fetched for a tab nobody is looking at.
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, hidden]);

  if (error) {
    return (
      <aside className="project-panel" aria-hidden={hidden}>
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      </aside>
    );
  }
  if (!detail) {
    return (
      <aside className="project-panel" aria-hidden={hidden}>
        <p className="ops-muted">Loading…</p>
      </aside>
    );
  }

  const { project, tables, pages, sites } = detail;

  return (
    <aside className="project-panel" aria-label={`${project.name} workspace`} aria-hidden={hidden}>
      <div className="project-panel-head">
        <div className="project-panel-title">
          <h2>{project.name}</h2>
          <div className="project-panel-meta">
            {/* A dot and a word, not a boxed capital ACTIVE: the status is
                one fact among three here, not a badge. */}
            <span className={`project-panel-status is-${project.status}`}>
              <i aria-hidden="true" />
              {project.status}
            </span>
            <span>{project.type}</span>
            <span className="ops-mono">{project.slug}</span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          title="The project's folder on the Files page"
          onClick={() => onOpenFile(detail.folder)}
        >
          Open in Files
        </button>
      </div>

      <ProjectExplorer
        slug={slug}
        root={detail.folder}
        onOpenInFiles={onOpenFile}
        onChanged={onChanged}
        onError={onError}
        paused={hidden}
      />

      <PanelSection title="Pages" count={pages.length}>
        {pages.length === 0 ? (
          <p className="hint">No pages yet.</p>
        ) : (
          <div className="project-panel-chips">
            {pages.map((pg) => (
              <a
                key={pg.id}
                className="ops-page-chip"
                href={hrefFor({ name: "page", id: pg.id })}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenPage(pg.id);
                }}
              >
                {pg.title}
              </a>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Tables" count={tables.length}>
        {tables.length === 0 ? (
          <p className="hint">No tables yet.</p>
        ) : (
          <ul className="insp-rows">
            {tables.map((t) => (
              <li key={t.name}>
                <span className="ops-mono">{t.name}</span>
                <span className="insp-meta">
                  {t.rows < 0 ? "unreadable" : `${t.rows.toLocaleString()} ${t.rows === 1 ? "row" : "rows"}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {sites.length > 0 && (
        <PanelSection title="Sites" count={sites.length}>
          <ul className="insp-rows">
            {sites.map((site) => (
              <li key={site.path}>
                {detail.sitesBase && site.hasIndex ? (
                  <a
                    className="ops-link"
                    href={`${detail.sitesBase}/${encodeURIComponent(site.project)}/${encodeURIComponent(site.name)}/`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {site.name}
                  </a>
                ) : (
                  <span>{site.name}</span>
                )}
                <span className="insp-meta">{site.hasIndex ? "live" : "no index.html"}</span>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
    </aside>
  );
}
