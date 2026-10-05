import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { api, type DirEntry, type FileContent } from "./api.js";
import { readFile, useDropZone } from "./Attachments.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { ImageView, Thumb } from "./FileThumb.js";
import { highlights, tokenize } from "./highlight.js";
import { ChevronLeft, ChevronRight } from "./icons.js";
import { Markdown } from "./Markdown.js";
import { PanelSection } from "./PanelSection.js";

/**
 * The project's folder, browsed in place.
 *
 * Folders open here, files open here: a picture is shown, a markdown file is
 * rendered, code is coloured, and the Files page is one button away for
 * anyone who wants the whole workspace. Before this every click left the
 * chat for the Files tab, which is a page change to look at one file.
 * Uploads and drops land in the folder being looked at.
 */

export interface ProjectExplorerProps {
  slug: string;
  /** The project's folder, workspace-relative. */
  root: string;
  /** Open this path on the Files page. Taken only when asked for. */
  onOpenInFiles: (path: string) => void;
  /** Something changed that the rest of the dashboard lists too. */
  onChanged: () => void;
  onError: (message: string) => void;
  /** Off screen: nothing is polled until it is back. */
  paused?: boolean;
}

/** How often the folder is re-read, so a file an agent wrote shows up. */
const POLL_MS = 5000;

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ms: number): string {
  if (!ms) return "";
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Folders first, then by name: a folder is a place, and places come before things. */
function sorted(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** One file, shown for what it is. */
function FileView({ file }: { file: FileContent }): ReactElement {
  if (file.omitted === "binary") {
    return previewable(file.path) ? (
      <ImageView path={file.path} />
    ) : (
      <p className="hint">Binary file. Open it in Files or the workspace folder.</p>
    );
  }
  if (file.omitted === "too-large") return <p className="hint">Too large to show here. Open it in Files.</p>;
  if (file.text === undefined) return <p className="hint">Nothing to show.</p>;
  if (file.language === "markdown") {
    return (
      <div className="explorer-md">
        <Markdown text={file.text} />
      </div>
    );
  }
  return (
    <pre className="explorer-pre">
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
  );
}

export function ProjectExplorer({ slug, root, onOpenInFiles, onChanged, onError, paused = false }: ProjectExplorerProps): ReactElement {
  /** The folder being looked at, relative to the project's folder; "" is the root. */
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** The file open in place, if one is. */
  const [filePath, setFilePath] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  /** How far through a batch of uploads, while one is in flight. */
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const here = dir ? `${root}/${dir}` : root;

  const list = useCallback(async (): Promise<void> => {
    try {
      const res = await api.files(here);
      setEntries(res.entries);
      setListError(null);
    } catch (err) {
      setListError(message(err));
    }
  }, [here]);

  // Another project's folder is another place: start at its root.
  useEffect(() => {
    setDir("");
    setFilePath(null);
  }, [root]);

  useEffect(() => {
    setEntries(null);
    setListError(null);
    if (paused) return;
    void list();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void list();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [list, paused]);

  // The open file, re-read on the same beat so an agent's rewrite shows.
  useEffect(() => {
    if (!filePath || paused) {
      setFile(null);
      setFileError(null);
      return;
    }
    let cancelled = false;
    const read = (): void => {
      void api
        .file(filePath)
        .then((f) => {
          if (cancelled) return;
          setFile((cur) => (cur && cur.modifiedAt === f.modifiedAt && cur.size === f.size ? cur : f));
          setFileError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setFileError(message(err));
        });
    };
    read();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") read();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [filePath, paused]);

  const upload = async (picked: FileList | null): Promise<void> => {
    if (!picked?.length || uploading) return;
    const files = Array.from(picked);
    setUploading({ done: 0, total: files.length });
    const failed: string[] = [];
    for (const [i, f] of files.entries()) {
      try {
        await api.uploadProjectFile(slug, await readFile(f), dir);
      } catch (err) {
        failed.push(`${f.name}: ${message(err)}`);
      }
      setUploading({ done: i + 1, total: files.length });
    }
    setUploading(null);
    if (failed.length > 0) onError(failed.join(" · "));
    await list();
    onChanged();
  };

  const drop = useDropZone((picked) => void upload(picked));

  /** The folder's path relative to the project, from an entry inside it. */
  const relative = (e: DirEntry): string => (e.path.startsWith(`${root}/`) ? e.path.slice(root.length + 1) : e.name);

  const shown = useMemo(() => (entries ? sorted(entries) : []), [entries]);
  const segments = dir ? dir.split("/") : [];
  const fileName = filePath ? (filePath.split("/").pop() ?? filePath) : "";

  return (
    <PanelSection
      title="Files & images"
      {...(entries && !filePath ? { count: entries.length } : {})}
      className={drop.over ? "project-panel-drop is-over" : "project-panel-drop"}
      {...drop.handlers}
      action={
        <>
          <button
            type="button"
            className="btn btn--sm"
            disabled={uploading !== null}
            title={dir ? `Upload into ${dir}` : "Upload into the project"}
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
      {filePath ? (
        <div className="explorer-file">
          <div className="explorer-file-head">
            <button type="button" className="explorer-back" onClick={() => setFilePath(null)}>
              <ChevronLeft size={13} />
              {segments.length > 0 ? segments[segments.length - 1] : slug}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => onOpenInFiles(filePath)}>
              Open in Files
            </button>
          </div>
          <div className="explorer-file-name">
            <FileIcon name={fileName} kind="file" />
            <strong>{fileName}</strong>
            {file && (
              <span className="explorer-meta">
                {bytes(file.size)}
                {file.language && file.language !== "text" ? ` · ${file.language}` : ""}
                {file.modifiedAt ? ` · ${ago(file.modifiedAt)}` : ""}
              </span>
            )}
          </div>
          {fileError && (
            <p className="ops-alert ops-alert--err" role="alert">
              {fileError}
            </p>
          )}
          {!file && !fileError && <p className="hint">Loading…</p>}
          {file && <FileView file={file} />}
        </div>
      ) : (
        <>
          <nav className="explorer-crumbs" aria-label="Folder">
            <button type="button" className={segments.length === 0 ? "is-here" : ""} onClick={() => setDir("")}>
              {slug}
            </button>
            {segments.map((seg, i) => (
              <span key={segments.slice(0, i + 1).join("/")} className="explorer-crumb">
                <ChevronRight size={11} />
                <button
                  type="button"
                  className={i === segments.length - 1 ? "is-here" : ""}
                  onClick={() => setDir(segments.slice(0, i + 1).join("/"))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </nav>
          {listError && (
            <p className="ops-alert ops-alert--err" role="alert">
              {listError}
            </p>
          )}
          {entries === null && !listError && <p className="hint">Loading…</p>}
          {entries !== null && entries.length === 0 && (
            <p className="hint">Nothing here yet. Drop files here or upload them.</p>
          )}
          {shown.length > 0 && (
            <ul className="explorer-list">
              {shown.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    className={`explorer-row explorer-row--${e.kind}`}
                    title={e.name}
                    onClick={() => (e.kind === "dir" ? setDir(relative(e)) : setFilePath(e.path))}
                  >
                    {e.kind === "file" && previewable(e.name) ? (
                      <Thumb path={e.path} name={e.name} />
                    ) : (
                      <FileIcon name={e.name} kind={e.kind} size={15} />
                    )}
                    <span className="explorer-name">{e.name}</span>
                    <span className="explorer-meta">{e.kind === "file" ? bytes(e.size) : ago(e.modifiedAt)}</span>
                    {e.kind === "dir" && <ChevronRight size={12} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PanelSection>
  );
}
