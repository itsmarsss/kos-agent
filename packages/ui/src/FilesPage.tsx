import { useEffect, useState, type ReactElement } from "react";

import { api, type DirEntry, type FileContent } from "./api.js";
import { Markdown } from "./Markdown.js";
import { hrefFor } from "./routes.js";

/**
 * Read-only browsing of the workspace.
 *
 * KOS's whole premise is that everything is one folder you own, so being able
 * to see that folder is not a convenience. Reveal-in-Finder covers the desktop
 * case; this covers looking at what the agent wrote without leaving the page,
 * and works when the dashboard is not on the machine holding the workspace.
 */

export interface FilesPageProps {
  path?: string;
  onOpen: (path: string) => void;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

/** A directory listing, or the file, depending on what the path points at. */
export function FilesPage({ path = ".", onOpen }: FilesPageProps): ReactElement {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFile(null);
    setEntries(null);

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

  const trail = crumbs(path);

  return (
    <div className="files">
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

      {loading && <p className="hint">Loading…</p>}
      {error && (
        <p className="ops-alert ops-alert--err" role="alert">
          {error}
        </p>
      )}

      {entries && (
        <div className="files-list">
          {entries.length === 0 && <p className="hint">This folder is empty.</p>}
          {entries.map((e) => (
            <a
              key={e.path}
              className="files-row"
              href={hrefFor({ name: "files", path: e.path })}
              onClick={(ev) => {
                ev.preventDefault();
                onOpen(e.path);
              }}
            >
              <span className="files-icon">{e.kind === "dir" ? "▸" : "·"}</span>
              <span className="files-name">{e.name}</span>
              <span className="files-size">
                {e.kind === "file" ? bytes(e.size) : ""}
              </span>
            </a>
          ))}
        </div>
      )}

      {file && (
        <div className="files-file">
          <header className="files-file-head">
            <strong>{file.path}</strong>
            <span className="hint">
              {bytes(file.size)}
              {file.language ? ` · ${file.language}` : ""}
            </span>
          </header>
          {file.omitted === "binary" && (
            <p className="hint">
              Binary file. Open the workspace folder to view it.
            </p>
          )}
          {file.omitted === "too-large" && (
            <p className="hint">Too large to display here.</p>
          )}
          {file.text !== undefined &&
            (file.language === "markdown" ? (
              <div className="files-md">
                <Markdown text={file.text} />
              </div>
            ) : (
              <pre className="files-pre">{file.text}</pre>
            ))}
        </div>
      )}
    </div>
  );
}
