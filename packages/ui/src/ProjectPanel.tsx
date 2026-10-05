import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { api, type DirEntry, type ProjectDetail } from "./api.js";
import { readFile, useDropZone } from "./Attachments.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { Thumb } from "./FileThumb.js";
import { hrefFor } from "./routes.js";

/**
 * The column beside a project's threads: what the project has made and what
 * the owner has put in it. Files and pictures, with upload and drop; pages;
 * tables; sites. The work happens in the thread next to it, and this is
 * where the work lands, so the two sit side by side rather than a page apart.
 */

export interface ProjectPanelProps {
  slug: string;
  onOpenPage: (id: string) => void;
  onOpenFile: (path: string) => void;
  /** Something changed that the rest of the dashboard lists too. */
  onChanged: () => void;
  onError: (message: string) => void;
}

/** How often the panel re-reads the project, so a file an agent wrote shows up. */
const POLL_MS = 5000;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Section({
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

function FileTile({ entry, onOpen }: { entry: DirEntry; onOpen: (path: string) => void }): ReactElement {
  return (
    <a
      className="files-tile"
      href={hrefFor({ name: "files", path: entry.path })}
      title={entry.name}
      onClick={(e) => {
        e.preventDefault();
        onOpen(entry.path);
      }}
    >
      {entry.kind === "file" && previewable(entry.name) ? (
        <Thumb path={entry.path} name={entry.name} />
      ) : (
        <div className="files-thumb">
          <FileIcon name={entry.name} kind={entry.kind} size={26} />
        </div>
      )}
      <span className="files-tile-name">{entry.name}</span>
      <span className="files-tile-meta">{entry.kind === "file" ? bytes(entry.size) : "folder"}</span>
    </a>
  );
}

export function ProjectPanel({ slug, onOpenPage, onOpenFile, onChanged, onError }: ProjectPanelProps): ReactElement {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** How far through a batch of uploads, while one is in flight. */
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await api.projectDetail(slug));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [slug]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void load();
    // Nothing is fetched for a tab nobody is looking at.
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const upload = async (list: FileList | null): Promise<void> => {
    if (!list?.length || uploading) return;
    const files = Array.from(list);
    setUploading({ done: 0, total: files.length });
    const failed: string[] = [];
    for (const [i, file] of files.entries()) {
      try {
        await api.uploadProjectFile(slug, await readFile(file));
      } catch (err) {
        failed.push(`${file.name}: ${message(err)}`);
      }
      setUploading({ done: i + 1, total: files.length });
    }
    setUploading(null);
    if (failed.length > 0) onError(failed.join(" · "));
    await load();
    onChanged();
  };

  const drop = useDropZone((list) => void upload(list));

  if (error) {
    return (
      <aside className="project-panel">
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      </aside>
    );
  }
  if (!detail) {
    return (
      <aside className="project-panel">
        <p className="ops-muted">Loading…</p>
      </aside>
    );
  }

  const { project, tables, pages, sites, files } = detail;

  return (
    <aside className="project-panel" aria-label={`${project.name} workspace`}>
      <div className="project-panel-head">
        <div className="project-panel-title">
          <h2>{project.name}</h2>
          <div className="project-panel-meta">
            <span className={`ops-status ops-status--${project.status}`}>{project.status}</span>
            <span>{project.type}</span>
            <span className="ops-mono">{project.slug}</span>
          </div>
        </div>
        <button type="button" className="btn btn--sm" onClick={() => onOpenFile(detail.folder)}>
          Folder
        </button>
      </div>

      <Section
        title="Files & images"
        count={files.length}
        className={drop.over ? "project-panel-drop is-over" : "project-panel-drop"}
        {...drop.handlers}
        action={
          <>
            <button
              type="button"
              className="btn btn--sm"
              disabled={uploading !== null}
              onClick={() => picker.current?.click()}
            >
              {uploading ? `${uploading.done} of ${uploading.total}…` : "Upload"}
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Upload files"
              onChange={(e) => {
                void upload(e.target.files);
                // Cleared so picking the same file twice still fires a change.
                e.target.value = "";
              }}
            />
          </>
        }
      >
        {files.length === 0 ? (
          <p className="hint">Nothing here yet. Drop files here or upload them.</p>
        ) : (
          <div className="files-grid">
            {files.map((f) => (
              <FileTile key={f.path} entry={f} onOpen={onOpenFile} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Pages" count={pages.length}>
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
      </Section>

      <Section title="Tables" count={tables.length}>
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
      </Section>

      {sites.length > 0 && (
        <Section title="Sites" count={sites.length}>
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
        </Section>
      )}
    </aside>
  );
}
