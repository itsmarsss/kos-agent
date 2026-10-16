import { useRef, useState, type CSSProperties, type DragEvent, type ReactElement, type ReactNode } from "react";

import { AnimatePresence, m } from "motion/react";

import { api } from "./api.js";
import { MoreIcon } from "./icons.js";
import { Modal } from "./Modal.js";
import { useDismiss } from "./useDismiss.js";

/**
 * What can be done to a file or folder by hand, shared by the Files page
 * and a project's explorer: open, download, rename, duplicate, move,
 * delete, and a new folder. One menu per row, one set of dialogs per view,
 * and drag-and-drop between rows and folders, so the two places a file is
 * seen offer the same handles.
 */

export interface Entry {
  path: string;
  name: string;
  kind: "dir" | "file";
}

/** The type a dragged row carries, so a file dropped from the desktop is not mistaken for one. */
const DRAG_TYPE = "application/x-kos-path";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

type Dialog =
  | { kind: "rename"; entry: Entry; value: string }
  | { kind: "move"; entry: Entry; value: string }
  | { kind: "delete"; entry: Entry }
  | { kind: "mkdir"; dir: string; value: string };

/** What was done, so a view can follow a rename or leave a deleted file. */
export interface FileChange {
  op: "rename" | "copy" | "delete" | "mkdir";
  /** What it was done to. */
  from: string;
  /** Where the result is; nothing after a delete. */
  path?: string;
}

export interface FileOps {
  open: (entry: Entry) => void;
  download: (entry: Entry) => void;
  rename: (entry: Entry) => void;
  duplicate: (entry: Entry) => void;
  move: (entry: Entry) => void;
  moveTo: (entry: Entry, dir: string) => void;
  remove: (entry: Entry) => void;
  newFolder: (dir: string) => void;
  /** Whether something is being done right now. */
  busy: boolean;
  /** The dialogs, rendered once by the view. */
  dialogs: ReactNode;
}

/**
 * The operations, with their dialogs.
 *
 * `onChanged` is told after anything that alters the listing, with what was
 * done and where the result is, so the view can refresh, follow a rename, or
 * leave a file that is gone. `folders` are offered as destinations when
 * moving.
 */
export function useFileOps({
  onOpen,
  onChanged,
  onError,
  folders = [],
}: {
  onOpen: (entry: Entry) => void;
  onChanged: (change: FileChange) => void;
  onError: (text: string) => void;
  folders?: string[];
}): FileOps {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (op: FileChange["op"], from: string, work: () => Promise<{ path: string }>): Promise<void> => {
    setBusy(true);
    try {
      const result = await work();
      setDialog(null);
      onChanged(op === "delete" ? { op, from } : { op, from, path: result.path });
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const download = (entry: Entry): void => {
    void api
      .downloadFile(entry.path)
      .catch((err: unknown) => onError(message(err)));
  };

  const moveTo = (entry: Entry, dir: string): void => {
    const to = joinPath(dir.replace(/^\.?\/?/, "").replace(/\/+$/, ""), entry.name);
    if (to === entry.path) return;
    void run("rename", entry.path, () => api.renameFile(entry.path, to));
  };

  const dialogs = (
    <>
      <Modal open={dialog?.kind === "rename"} title="Rename" onClose={() => setDialog(null)}>
        {dialog?.kind === "rename" && (
          <form
            className="file-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              const name = dialog.value.trim();
              if (!name || name.includes("/")) return;
              void run("rename", dialog.entry.path, () => api.renameFile(dialog.entry.path, joinPath(parentOf(dialog.entry.path), name)));
            }}
          >
            <input
              className="kos-input"
              value={dialog.value}
              autoFocus
              onFocus={(e) => {
                // The name, not the extension, is what gets retyped.
                const dot = e.target.value.lastIndexOf(".");
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
            />
            <div className="file-dialog-actions">
              <button type="submit" className="btn btn--primary" disabled={busy || !dialog.value.trim() || dialog.value.includes("/")}>
                Rename
              </button>
              <button type="button" className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={dialog?.kind === "move"} title={`Move ${dialog?.kind === "move" ? dialog.entry.name : ""}`} onClose={() => setDialog(null)}>
        {dialog?.kind === "move" && (
          <form
            className="file-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              moveTo(dialog.entry, dialog.value.trim());
            }}
          >
            <label className="file-dialog-label">
              Into folder
              <input
                className="kos-input ops-mono"
                value={dialog.value}
                autoFocus
                placeholder="projects/garden/notes"
                onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
              />
            </label>
            {folders.length > 0 && (
              <div className="file-dialog-folders">
                {folders
                  .filter((f) => f !== dialog.entry.path && !f.startsWith(`${dialog.entry.path}/`))
                  .map((f) => (
                    <button key={f || "."} type="button" className="file-dialog-folder" onClick={() => setDialog({ ...dialog, value: f })}>
                      {f || "workspace root"}
                    </button>
                  ))}
              </div>
            )}
            <div className="file-dialog-actions">
              <button type="submit" className="btn btn--primary" disabled={busy}>
                Move
              </button>
              <button type="button" className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={dialog?.kind === "delete"} title="Delete" onClose={() => setDialog(null)}>
        {dialog?.kind === "delete" && (
          <div className="file-dialog">
            <p>
              Delete <strong>{dialog.entry.name}</strong>
              {dialog.entry.kind === "dir" ? " and everything in it" : ""}? There is no undo.
            </p>
            <div className="file-dialog-actions">
              <button type="button" className="btn btn--danger-ghost" disabled={busy} onClick={() => void run("delete", dialog.entry.path, () => api.deleteFile(dialog.entry.path))}>
                Delete
              </button>
              <button type="button" className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={dialog?.kind === "mkdir"} title="New folder" onClose={() => setDialog(null)}>
        {dialog?.kind === "mkdir" && (
          <form
            className="file-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              const name = dialog.value.trim();
              if (!name || name.includes("/")) return;
              void run("mkdir", dialog.dir, () => api.makeDir(joinPath(dialog.dir, name)));
            }}
          >
            <input
              className="kos-input"
              value={dialog.value}
              autoFocus
              placeholder="Folder name"
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
            />
            <div className="file-dialog-actions">
              <button type="submit" className="btn btn--primary" disabled={busy || !dialog.value.trim() || dialog.value.includes("/")}>
                Create
              </button>
              <button type="button" className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );

  return {
    open: onOpen,
    download,
    rename: (entry) => setDialog({ kind: "rename", entry, value: entry.name }),
    duplicate: (entry) => void run("copy", entry.path, () => api.copyFile(entry.path)),
    move: (entry) => setDialog({ kind: "move", entry, value: parentOf(entry.path) }),
    moveTo,
    remove: (entry) => setDialog({ kind: "delete", entry }),
    newFolder: (dir) => setDialog({ kind: "mkdir", dir, value: "" }),
    busy,
    dialogs,
  };
}

/** The ⋯ on a row, and the menu it opens. In a file's own view there is nothing to open. */
export function EntryMenu({ entry, ops, inView = false }: { entry: Entry; ops: FileOps; inView?: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  /**
   * Where the menu goes, fixed to the viewport: the lists it sits in clip
   * their overflow (rounded corners, scrolling panels), and a menu that is
   * cut off at the edge of a one-row list is no menu at all. It closes on
   * scroll, so the fixed spot never goes stale.
   */
  const [place, setPlace] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const toggle = (button: HTMLElement): void => {
    const r = button.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 240;
    setPlace(below ? { top: r.bottom + 4, right: window.innerWidth - r.right } : { bottom: window.innerHeight - r.top + 4, right: window.innerWidth - r.right });
    setOpen((v) => !v);
  };
  const item = (label: string, act: () => void, danger = false): ReactElement => (
    <button
      type="button"
      role="menuitem"
      className={danger ? "is-danger" : ""}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        act();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="file-menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="icon-btn file-more"
        aria-label={`Actions for ${entry.name}`}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle(e.currentTarget);
        }}
      >
        <MoreIcon />
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            className="chats-menu file-menu"
            role="menu"
            style={place}
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            {!inView && item(entry.kind === "dir" ? "Open" : "Preview", () => ops.open(entry))}
            {!inView && entry.kind === "file" && item("Download", () => ops.download(entry))}
            {item("Rename", () => ops.rename(entry))}
            {item("Duplicate", () => ops.duplicate(entry))}
            {item("Move to…", () => ops.move(entry))}
            {item("Delete", () => ops.remove(entry), true)}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Make a row draggable as a workspace path. */
export function dragProps(entry: Entry): { draggable: true; onDragStart: (e: DragEvent) => void } {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(entry));
      e.dataTransfer.effectAllowed = "move";
    },
  };
}

/** Whether a drag carries a workspace path rather than files from the desktop. */
export function carriesPath(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
}

/**
 * Let a folder (or a crumb) take a dropped row. `onOver` is told whether a
 * row is over it, for the highlight; a desktop file drop is left to whoever
 * handles uploads.
 */
export function dropProps(
  dir: string,
  ops: FileOps,
  onOver?: (over: boolean) => void,
): { onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void } {
  return {
    onDragOver: (e) => {
      if (!carriesPath(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      onOver?.(true);
    },
    onDragLeave: () => onOver?.(false),
    onDrop: (e) => {
      if (!carriesPath(e)) return;
      e.preventDefault();
      e.stopPropagation();
      onOver?.(false);
      try {
        const entry = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as Entry;
        if (entry.path === dir || dir.startsWith(`${entry.path}/`) || parentOf(entry.path) === dir) return;
        ops.moveTo(entry, dir);
      } catch {
        // Not one of ours after all.
      }
    },
  };
}
