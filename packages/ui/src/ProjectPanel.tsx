import { useCallback, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { hexOfHsl, hueOfHex } from "@kos/shared";
import { Card, Empty, lookOf, Pill } from "@kos/kit";

import { api, type ProjectDetail } from "./api.js";
import { ColourChoice } from "./ColourPicker.js";
import { FileIcon } from "./FileIcon.js";
import { ProjectExplorer } from "./ProjectExplorer.js";
import { markInk } from "./ProjectMark.js";

/**
 * The column beside a project's threads: who the project is and how much it
 * holds, then what it has made and what the owner has put in it, each a
 * section under a hairline rather than a box: its folder, browsed in place;
 * its artifacts; tables; sites. Its agents and schedule are the rail on the
 * other side of the thread. The work happens in the thread between, and
 * this is where the work lands, so the two sit side by side.
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
  /** The colour row under the head, shown on request. */
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
  /** What it holds, at a glance: each a section below, or the rail beside the chat. */
  const stats: [string, number][] = [
    ["Agents", detail.agents.length],
    ["Artifacts", detail.pages.filter((p) => p.trashedAt === undefined).length],
    ["Tables", tables.length],
    ["Schedules", detail.crons.length],
  ];
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
      {/* Who it is: its mark in its own colour, its name, kind and state,
          what it is for, how much it holds, and what can be done with it. */}
      <header className="project-head">
        <div className="project-head-top">
          <span className="hero-mark hero-mark--sm" aria-hidden="true" style={project.colour ? { background: project.colour, color: markInk(project.colour) } : undefined}>
            <FileIcon name={project.slug} kind="dir" size={16} />
          </span>
          <div className="project-head-titles">
            <h2>{project.name}</h2>
            <span className="project-head-sub">
              {project.type} · <span className="ops-mono">{project.slug}</span>
            </span>
          </div>
          <Pill tone={project.status === "active" ? "ok" : "muted"}>{project.status}</Pill>
        </div>
        {project.description && <p className="project-head-desc">{project.description}</p>}
        <dl className="project-stats">
          {stats.map(([label, n]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
        <div className="project-head-acts">
          <button type="button" className="btn btn--sm" title="The project's folder on the Files page" onClick={() => onOpenFile(detail.folder)}>
            Open in Files
          </button>
          <button type="button" className="btn btn--sm btn--ghost" aria-expanded={colouring} onClick={() => setColouring((v) => !v)} title="Give the project a colour of its own">
            Colour
          </button>
        </div>
        {colouring && (
          /* The same swatches and picker a face has; a project's swatch is the plain colour. */
          <div className="project-head-colour">
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
