import { useCallback, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { hexOfHsl, hueOfHex } from "@kos/shared";
import { Card, Empty, lookOf, Pill, Tag } from "@kos/kit";

import { api, type ProjectDetail } from "./api.js";
import { ColourChoice } from "./ColourPicker.js";
import { FileIcon } from "./FileIcon.js";
import { ProjectExplorer } from "./ProjectExplorer.js";
import { markInk } from "./ProjectMark.js";

/**
 * The column beside a project's threads: what the project has made and what
 * the owner has put in it. Its folder, browsed in place; pages; tables;
 * sites. The work happens in the thread next to it, and this is where the
 * work lands, so the two sit side by side rather than a page apart.
 */

export interface ProjectPanelProps {
  slug: string;
  onOpenFile: (path: string) => void;
  /** Something changed that the rest of the dashboard lists too. */
  onChanged: () => void;
  onError: (message: string) => void;
  /** Slid shut: still mounted so it can slide open, but polling nothing. */
  hidden?: boolean;
  /** The project's artifacts (ArtifactRail), which open in place beside it. */
  rail: ReactNode;
}

/** How often the panel re-reads the project, so a page an agent made shows up. */
const POLL_MS = 5000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ProjectPanel({ slug, onOpenFile, onChanged, onError, hidden = false, rail }: ProjectPanelProps): ReactElement {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The colour row under the hero, shown on request. */
  const [colouring, setColouring] = useState(false);

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

  const { project, tables, sites } = detail;
  const hue = (project.colour ? hueOfHex(project.colour) : null) ?? lookOf(project.slug).hue;
  const recolour = async (colour: string | null): Promise<void> => {
    try {
      await api.setProjectColour(project.slug, colour);
      await load();
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <aside className="project-panel" aria-label={`${project.name} workspace`} aria-hidden={hidden} style={{ "--blob-h": String(hue) } as CSSProperties}>
      {/* Who it is, as the agent page has it: a mark on a glow of the
          project's own colour, its name, what it is for, and its facts. */}
      <header className="hero">
        <span className="hero-mark" aria-hidden="true" style={project.colour ? { background: project.colour, color: markInk(project.colour) } : undefined}>
          <FileIcon name={project.slug} kind="dir" size={26} />
        </span>
        <h2>{project.name}</h2>
        {project.description && <p className="hero-desc">{project.description}</p>}
        <div className="hero-meta">
          <Pill tone={project.status === "active" ? "ok" : "muted"}>{project.status}</Pill>
          <Tag>{project.type}</Tag>
          <Tag mono>{project.slug}</Tag>
        </div>
        <div className="hero-acts">
          <button type="button" className="btn btn--sm" title="The project's folder on the Files page" onClick={() => onOpenFile(detail.folder)}>
            Open in Files
          </button>
          <button type="button" className="btn btn--sm btn--ghost" aria-expanded={colouring} onClick={() => setColouring((v) => !v)} title="Give the project a colour of its own">
            Colour
          </button>
        </div>
        {colouring && (
          /* The same swatches and picker a face has; a project's swatch is the plain colour. */
          <div className="hero-colour">
            <ColourChoice
              value={project.colour ?? hexOfHsl(hue, 70, 60)}
              swatchHue={project.colour ? undefined : hue}
              picked={Boolean(project.colour)}
              fillOfHue={(h) => `hsl(${h} 70% 60%)`}
              onSwatch={(h) => void recolour(hexOfHsl(h, 70, 60))}
              onPick={(hex) => void recolour(hex)}
            />
            {project.colour && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void recolour(null)} title="Let the name decide again">
                From the name
              </button>
            )}
          </div>
        )}
      </header>

      <ProjectExplorer
        label={slug}
        root={detail.folder}
        upload={(file, dir) => api.uploadProjectFile(slug, file, dir)}
        onOpenInFiles={onOpenFile}
        onChanged={onChanged}
        onError={onError}
        paused={hidden}
      />

      {rail}

      <Card className="project-panel-section" title="Tables" count={tables.length}>
        {tables.length === 0 ? (
          <Empty inline>No tables yet.</Empty>
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
      </Card>

      {sites.length > 0 && (
        <Card className="project-panel-section" title="Sites" count={sites.length}>
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
        </Card>
      )}
    </aside>
  );
}
