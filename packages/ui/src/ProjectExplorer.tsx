import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { api, type DirEntry } from "./api.js";
import { readFile, useDropZone } from "./Attachments.js";
import { EntryMenu, dragProps, dropProps, useFileOps } from "./FileActions.js";
import { FileIcon, previewable } from "./FileIcon.js";
import { FilePreview, ago, bytes } from "./FilePreview.js";
import { Thumb } from "./FileThumb.js";
import { ChevronRight } from "./icons.js";
import { PanelSection } from "./PanelSection.js";

/**
 * The project's folder, browsed in place.
 *
 * Folders open here; a file opens in a window over the page (a picture
 * shown, markdown rendered, code coloured) with the folder still in view
 * and the arrows stepping to the next file. The Files page is one button
 * away for anyone who wants the whole workspace. Uploads and drops land
 * in the folder being looked at, and what is here can be renamed, moved,
 * duplicated, downloaded and deleted in place.
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

export function ProjectExplorer({ slug, root, onOpenInFiles, onChanged, onError, paused = false }: ProjectExplorerProps): ReactElement {
  /** The folder being looked at, relative to the project's folder; "" is the root. */
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** The file open in the preview, if one is. */
  const [filePath, setFilePath] = useState<string | null>(null);
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

  // A different folder starts blank; a paused one keeps its listing.
  useEffect(() => {
    setEntries(null);
    setListError(null);
  }, [here]);

  useEffect(() => {
    if (paused) return;
    void list();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void list();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [list, paused]);

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
  const relative = (e: { path: string; name: string }): string => (e.path.startsWith(`${root}/`) ? e.path.slice(root.length + 1) : e.name);

  const shown = useMemo(() => (entries ? sorted(entries) : []), [entries]);
  const files = useMemo(() => shown.filter((e) => e.kind === "file").map((e) => e.path), [shown]);
  const segments = dir ? dir.split("/") : [];
  const fileName = filePath ? (filePath.split("/").pop() ?? filePath) : "";
  /** The folder a dragged row is over, for the highlight. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const overHandlers = (target: string) => (over: boolean): void =>
    setDropTarget((cur) => (over ? target : cur === target ? null : cur));

  const ops = useFileOps({
    onOpen: (e) => (e.kind === "dir" ? setDir(relative(e)) : setFilePath(e.path)),
    onChanged: (c) => {
      // The open file follows its rename while it stays in the project, and
      // is left when it is deleted or moved out.
      if (filePath && c.from === filePath) {
        if (c.op === "delete") setFilePath(null);
        else if (c.op === "rename") setFilePath(c.path && c.path.startsWith(`${root}/`) ? c.path : null);
      }
      void list();
      onChanged();
    },
    onError,
    folders: [root, ...segments.map((_, i) => `${root}/${segments.slice(0, i + 1).join("/")}`), ...shown.filter((e) => e.kind === "dir").map((e) => e.path)],
  });

  return (
    <PanelSection
      title="Files & images"
      {...(entries ? { count: entries.length } : {})}
      className={drop.over ? "project-panel-drop is-over" : "project-panel-drop"}
      {...drop.handlers}
      action={
        <>
          <button type="button" className="btn btn--sm" title={dir ? `New folder in ${dir}` : "New folder in the project"} onClick={() => ops.newFolder(here)}>
            New folder
          </button>
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
      <nav className="explorer-crumbs" aria-label="Folder">
        <button
          type="button"
          className={`${segments.length === 0 ? "is-here" : ""}${dropTarget === root ? " is-drop" : ""}`}
          onClick={() => setDir("")}
          {...dropProps(root, ops, overHandlers(root))}
        >
          {slug}
        </button>
        {segments.map((seg, i) => {
          const sub = segments.slice(0, i + 1).join("/");
          const target = `${root}/${sub}`;
          return (
            <span key={sub} className="explorer-crumb">
              <ChevronRight size={11} />
              <button
                type="button"
                className={`${i === segments.length - 1 ? "is-here" : ""}${dropTarget === target ? " is-drop" : ""}`}
                onClick={() => setDir(sub)}
                {...dropProps(target, ops, overHandlers(target))}
              >
                {seg}
              </button>
            </span>
          );
        })}
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
            <li
              key={e.path}
              className={`explorer-row-wrap${dropTarget === e.path ? " is-drop" : ""}`}
              {...dragProps(e)}
              {...(e.kind === "dir" ? dropProps(e.path, ops, overHandlers(e.path)) : {})}
            >
              <button
                type="button"
                className={`explorer-row explorer-row--${e.kind}`}
                title={e.name}
                onClick={() => (e.kind === "dir" ? setDir(relative(e)) : setFilePath(e.path))}
              >
                {e.kind === "file" && previewable(e.name) ? (
                  <Thumb path={e.path} name={e.name} />
                ) : (
                  <span className={`explorer-glyph explorer-glyph--${e.kind}`}>
                    <FileIcon name={e.name} kind={e.kind} size={15} />
                  </span>
                )}
                <span className="explorer-text">
                  <span className="explorer-name">{e.name}</span>
                  <span className="explorer-sub">
                    <span>{e.kind === "file" ? bytes(e.size) : "folder"}</span>
                    {e.modifiedAt ? (
                      <>
                        <span className="explorer-dot">·</span>
                        <span>{ago(e.modifiedAt)}</span>
                      </>
                    ) : null}
                  </span>
                </span>
                {e.kind === "dir" && <ChevronRight size={12} />}
              </button>
              <EntryMenu entry={e} ops={ops} />
            </li>
          ))}
        </ul>
      )}
      <FilePreview
        path={filePath}
        siblings={files}
        onStep={setFilePath}
        onClose={() => setFilePath(null)}
        paused={paused}
        actions={
          filePath && (
            <>
              <button type="button" className="btn btn--sm" onClick={() => onOpenInFiles(filePath)}>
                Open in Files
              </button>
              <button type="button" className="btn btn--sm" onClick={() => ops.download({ path: filePath, name: fileName, kind: "file" })}>
                Download
              </button>
              <EntryMenu entry={{ path: filePath, name: fileName, kind: "file" }} ops={ops} inView />
            </>
          )
        }
      />
      {ops.dialogs}
    </PanelSection>
  );
}
