import { useEffect, useMemo, useState, type ReactElement } from "react";

import { m } from "motion/react";
import { highlights, tokenize } from "./highlight.js";
import { ease } from "./motion.js";
import { api, type DirEntry, type FileContent } from "./api.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { ImageView, Thumb } from "./FileThumb.js";
import { Markdown } from "./Markdown.js";
import { hrefFor } from "./routes.js";
import { Select } from "./Select.js";

/**
 * Read-only browsing of the workspace.
 *
 * KOS's whole premise is that everything is one folder you own, so being able
 * to see that folder is not a convenience. Reveal-in-Finder covers the desktop
 * case; this covers looking at what the agent wrote without leaving the page,
 * and works when the dashboard is not on the machine holding the workspace.
 *
 * Two ways to look at the same folder, because they answer different
 * questions. The list is for finding a known thing and reading its facts. The
 * grid is for a folder of pictures, where the name is not what you recognise
 * it by.
 */

export interface FilesPageProps {
  path?: string;
  onOpen: (path: string) => void;
}

type ViewMode = "list" | "grid";
type SortKey = "name" | "size" | "modified";

const VIEW_KEY = "kos.files.view";
const SORT_KEY = "kos.files.sort";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * When something was last touched, said the way you would say it. Exact dates
 * matter less than "the agent wrote this while I was out".
 */
function when(ms: number): string {
  if (!ms) return "";
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(new Date(ms).getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

/** Clickable ancestors of the current location. */
function crumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split("/").filter((p) => p && p !== ".");
  const out = [{ label: "workspace", path: "." }];
  parts.forEach((part, i) => {
    out.push({ label: part, path: parts.slice(0, i + 1).join("/") });
  });
  return out;
}

/** Directories stay together at the top whichever way the rest is sorted. */
function sortEntries(entries: DirEntry[], key: SortKey): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    if (key === "size") return b.size - a.size;
    if (key === "modified") return b.modifiedAt - a.modifiedAt;
    return a.name.localeCompare(b.name);
  });
}

function readStored<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    // Private browsing, or storage disabled. A default is fine.
    return fallback;
  }
}

/** A directory listing, or the file, depending on what the path points at. */
export function FilesPage({ path = ".", onOpen }: FilesPageProps): ReactElement {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<ViewMode>(() =>
    readStored<ViewMode>(VIEW_KEY, ["list", "grid"], "list"),
  );
  const [sort, setSort] = useState<SortKey>(() =>
    readStored<SortKey>(SORT_KEY, ["name", "size", "modified"], "name"),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFile(null);
    setEntries(null);
    // A filter that survived the move would hide a folder's contents for no
    // visible reason.
    setFilter("");

    // Try it as a directory; a path that is a file fails and is read instead.
    void api
      .files(path)
      .then((res) => {
        if (!cancelled) setEntries(res.entries);
      })
      .catch(() =>
        api
          .file(path)
          .then((f) => {
            if (!cancelled) setFile(f);
          })
          .catch((err: unknown) => {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  const choose = (next: ViewMode): void => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
  };

  const reorder = (next: SortKey): void => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // As above.
    }
  };

  const shown = useMemo(() => {
    if (!entries) return [];
    const q = filter.trim().toLowerCase();
    const matching = q
      ? entries.filter((e) => e.name.toLowerCase().includes(q))
      : entries;
    return sortEntries(matching, sort);
  }, [entries, filter, sort]);

  const trail = crumbs(path);
  const parent = trail.length > 1 ? trail[trail.length - 2] : null;

  return (
    <div className="files">
      <div className="files-bar">
        <nav className="files-crumbs" aria-label="Location">
          {trail.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="files-sep">/</span>}
              <a
                href={hrefFor({ name: "files", path: c.path })}
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(c.path);
                }}
              >
                {c.label}
              </a>
            </span>
          ))}
        </nav>

        {entries && (
          <div className="files-tools">
            <input
              className="kos-input files-filter"
              value={filter}
              placeholder="Filter…"
              aria-label="Filter this folder"
              onChange={(e) => setFilter(e.target.value)}
            />
            <Select
              className="files-sort"
              label="Sort by"
              value={sort}
              options={[
                { value: "name", label: "Name" },
                { value: "modified", label: "Last changed" },
                { value: "size", label: "Size" },
              ]}
              onChange={(v) => reorder(v as SortKey)}
            />
            <div className="files-view" role="group" aria-label="View as">
              <button
                type="button"
                className={`btn btn--icon ${view === "list" ? "is-on" : ""}`}
                aria-pressed={view === "list"}
                title="List"
                onClick={() => choose("list")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              </button>
              <button
                type="button"
                className={`btn btn--icon ${view === "grid" ? "is-on" : ""}`}
                aria-pressed={view === "grid"}
                title="Grid"
                onClick={() => choose("grid")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <rect x="4" y="4" width="7" height="7" rx="1.5" />
                  <rect x="13" y="4" width="7" height="7" rx="1.5" />
                  <rect x="4" y="13" width="7" height="7" rx="1.5" />
                  <rect x="13" y="13" width="7" height="7" rx="1.5" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

      {loading && <p className="hint">Loading…</p>}
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      {entries && (
        <>
          {entries.length === 0 && <p className="hint">This folder is empty.</p>}
          {entries.length > 0 && shown.length === 0 && (
            <p className="hint">Nothing here matches “{filter}”.</p>
          )}

          {shown.length > 0 && view === "list" && (
            /* Keyed on the folder, so stepping into one is a move you can
               follow. Small and quick: this is orientation, not decoration. */
            <m.div
              className="files-list"
              key={path}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={ease}
            >
              {shown.map((e) => (
                <a
                  key={e.path}
                  className="files-row"
                  href={hrefFor({ name: "files", path: e.path })}
                  onClick={(ev) => {
                    ev.preventDefault();
                    onOpen(e.path);
                  }}
                >
                  <FileIcon name={e.name} kind={e.kind} />
                  <span className="files-name">{e.name}</span>
                  <span className="files-when">{when(e.modifiedAt)}</span>
                  <span className="files-size">
                    {e.kind === "file" ? bytes(e.size) : ""}
                  </span>
                </a>
              ))}
            </m.div>
          )}

          {shown.length > 0 && view === "grid" && (
            <div className="files-grid">
              {shown.map((e) => (
                <a
                  key={e.path}
                  className="files-tile"
                  href={hrefFor({ name: "files", path: e.path })}
                  title={e.name}
                  onClick={(ev) => {
                    ev.preventDefault();
                    onOpen(e.path);
                  }}
                >
                  {e.kind === "file" && previewable(e.name) ? (
                    <Thumb path={e.path} name={e.name} />
                  ) : (
                    <div className="files-thumb">
                      <FileIcon name={e.name} kind={e.kind} size={30} />
                    </div>
                  )}
                  <span className="files-tile-name">{e.name}</span>
                  <span className="files-tile-meta">
                    {e.kind === "file" ? bytes(e.size) : "folder"}
                  </span>
                </a>
              ))}
            </div>
          )}
        </>
      )}

      {file && (
        <div className="files-file">
          <header className="files-file-head">
            <FileIcon name={file.path} kind="file" />
            <strong>{file.path}</strong>
            <span className="hint">
              {bytes(file.size)}
              {file.language ? ` · ${file.language}` : ""}
              {file.modifiedAt ? ` · ${when(file.modifiedAt)}` : ""}
            </span>
            {parent && (
              <a
                className="btn files-up"
                href={hrefFor({ name: "files", path: parent.path })}
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(parent.path);
                }}
              >
                Back to {parent.label}
              </a>
            )}
          </header>
          {file.omitted === "binary" &&
            (previewable(file.path) ? (
              // The reader treats an image as binary because it is not text.
              // That is right for reading it and wrong for showing it.
              <ImageView path={file.path} />
            ) : (
              <p className="hint">
                Binary file. Open the workspace folder to view it.
              </p>
            ))}
          {file.omitted === "too-large" && (
            <p className="hint">Too large to display here.</p>
          )}
          {file.text !== undefined &&
            (file.language === "markdown" ? (
              <div className="files-md">
                <Markdown text={file.text} />
              </div>
            ) : (
              <pre className="files-pre">
                {/* Coloured where the language is known; where it is not,
                    every run comes back plain and this is the old wall of
                    text, which is the right thing to fall back to. */}
                {highlights(file.language)
                  ? tokenize(file.text, file.language).map((t, i) =>
                      t.kind === "plain" ? (
                        t.text
                      ) : (
                        <span key={i} className={`tok tok--${t.kind}`}>
                          {t.text}
                        </span>
                      ),
                    )
                  : file.text}
              </pre>
            ))}
        </div>
      )}
    </div>
  );
}
