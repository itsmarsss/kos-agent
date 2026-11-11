import { Face, Field, NavIcon } from "@kos/kit";
import { RENAME_DESCRIPTION_MAX, RENAME_TITLE_MAX, WORKSPACE_SCOPE, relativeWords } from "@kos/shared";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { api, type PageSummary, type Project } from "./api.js";
import type { MenuItem } from "./ArtifactHead.js";
import { ConfirmButton } from "./kit.js";
import { Modal } from "./Modal.js";
import { ProjectMark } from "./ProjectMark.js";

/**
 * The owner's own handles on an artifact, wherever it is shown (its viewer's
 * menu, a gallery card's): rename it, copy it, give it to another owner, put
 * it in the trash, and from the trash restore it or delete it for good. One
 * set of dialogs per view, as files have (FileActions.tsx). KOS can rename,
 * copy and move what it reaches, but deletes nothing: the trash is the
 * owner's alone.
 */

/**
 * Which artifacts are in the trash, read once and shared by every card that
 * names one (a chat's artifact cards), and read again when the owner trashes,
 * restores or deletes one here.
 */
let trashRead: Promise<Set<string>> | undefined;
const trashWatchers = new Set<() => void>();
function trashIds(): Promise<Set<string>> {
  trashRead ??= api.trashedArtifacts().then((list) => new Set(list.map((a) => a.id)));
  trashRead.catch(() => (trashRead = undefined));
  return trashRead;
}
function trashChanged(): void {
  trashRead = undefined;
  for (const watch of trashWatchers) watch();
}

/** Whether the artifact with this id is in the trash, kept up as the trash changes. */
export function useInTrash(id: string): boolean {
  const [inTrash, setInTrash] = useState(false);
  useEffect(() => {
    let stale = false;
    const read = (): void =>
      void trashIds()
        .then((ids) => !stale && setInTrash(ids.has(id)))
        .catch(() => undefined);
    read();
    trashWatchers.add(read);
    return () => {
      stale = true;
      trashWatchers.delete(read);
    };
  }, [id]);
  return inTrash;
}

/** What was done, so a view can follow it: show the new title, open the copy, leave what went. */
export type ArtifactChange =
  | { op: "rename" | "duplicate" | "move" | "trash" | "restore"; record: PageSummary }
  | { op: "delete"; id: string };

/** Where an artifact can go, as the move picker lists it. */
interface Place {
  key: string;
  to: { project: string } | { blob: string };
  label: string;
  mark: ReactNode;
}

/** Where it is now, as a place's key; a removed blob's is no living blob's place, so none is marked. */
const placeKey = (r: Pick<PageSummary, "projectSlug" | "blob" | "blobRemoved">): string =>
  r.blob ? (r.blobRemoved ? "removed" : `blob:${r.blob}`) : r.projectSlug ? `project:${r.projectSlug}` : "workspace";

/** What "Delete forever" says before it goes. */
export const deleteWords = (title: string): string => `Delete “${title}” for good, with every version? This cannot be undone.`;

type Dialog = { kind: "rename"; record: PageSummary; title: string; description: string } | { kind: "move"; record: PageSummary; choice?: string };

export interface ArtifactOps {
  /** The menu's management: rename, duplicate, move and trash; restore and delete forever for one in the trash. */
  items: (record: PageSummary) => MenuItem[];
  restore: (record: PageSummary) => void;
  remove: (record: PageSummary) => void;
  busy: boolean;
  /** The dialogs, drawn once by the view. */
  dialogs: ReactNode;
}

export function useArtifactOps({ projects, onChanged, onError }: { projects: Project[]; onChanged: (change: ArtifactChange) => void; onError: (text: string) => void }): ArtifactOps {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [blobs, setBlobs] = useState<string[]>([]);
  const moving = dialog?.kind === "move";
  // The living blobs, read when the picker opens: one made since the page loaded is offered too.
  useEffect(() => {
    if (!moving) return;
    let stale = false;
    void api
      .agents()
      .then((got) => !stale && setBlobs(got.agents.map((a) => a.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [moving]);

  const run = async (work: () => Promise<ArtifactChange>): Promise<void> => {
    setBusy(true);
    try {
      const change = await work();
      setDialog(null);
      if (change.op === "trash" || change.op === "restore" || change.op === "delete") trashChanged();
      onChanged(change);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const did = (op: Exclude<ArtifactChange["op"], "delete">, work: Promise<PageSummary>): Promise<ArtifactChange> => work.then((record) => ({ op, record }));

  const restore = (record: PageSummary): void => void run(() => did("restore", api.restoreArtifact(record.id)));
  const remove = (record: PageSummary): void => void run(() => api.deleteArtifact(record.id).then(() => ({ op: "delete", id: record.id })));

  const items = (record: PageSummary): MenuItem[] =>
    record.trashedAt !== undefined
      ? [
          { label: "Restore", act: () => restore(record) },
          { label: "Delete forever", act: () => remove(record), danger: true, confirm: deleteWords(record.title) },
        ]
      : [
          { label: "Rename…", act: () => setDialog({ kind: "rename", record, title: record.title, description: record.description ?? "" }) },
          // Nothing new goes to a removed blob, so its work is moved out, not copied where it is.
          ...(record.blobRemoved ? [] : [{ label: "Duplicate", act: () => void run(() => did("duplicate", api.duplicateArtifact(record.id))) }]),
          { label: "Move to…", act: () => setDialog({ kind: "move", record }) },
          { label: "Move to trash", act: () => void run(() => did("trash", api.trashArtifact(record.id))), danger: true },
        ];

  const places: Place[] = [
    {
      key: "workspace",
      to: { project: WORKSPACE_SCOPE },
      label: "Workspace",
      mark: (
        <span className="tile artifact-move-ws" aria-hidden="true">
          <NavIcon name="files" />
        </span>
      ),
    },
    // Not Maintenance (a system project): it is where KOS repairs itself, not a place for the owner's work.
    ...projects
      .filter((p) => p.type !== "system")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p): Place => ({ key: `project:${p.slug}`, to: { project: p.slug }, label: p.name, mark: <ProjectMark slug={p.slug} name={p.name} colour={p.colour} /> })),
    ...blobs.map((name): Place => ({ key: `blob:${name}`, to: { blob: name }, label: name, mark: <Face seed={name} size={20} /> })),
  ];

  const dialogs = (
    <>
      <Modal open={dialog?.kind === "rename"} title="Rename" onClose={() => setDialog(null)}>
        {dialog?.kind === "rename" && (
          <form
            className="file-dialog artifact-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              const title = dialog.title.trim();
              if (!title) return;
              const { record } = dialog;
              // Only what changed: an older widget page has no description to send.
              const description = dialog.description.trim();
              const change = { ...(title !== record.title ? { title } : {}), ...(description !== (record.description ?? "") ? { description } : {}) };
              if (!("title" in change) && !("description" in change)) return setDialog(null);
              void run(() => did("rename", api.renameArtifact(record.id, change)));
            }}
          >
            <Field label="Title">
              <input className="kos-input" value={dialog.title} autoFocus maxLength={RENAME_TITLE_MAX} onFocus={(e) => e.target.select()} onChange={(e) => setDialog({ ...dialog, title: e.target.value })} />
            </Field>
            {dialog.record.kind === "html" && (
              <Field label="Description" hint="One sentence: what it is for.">
                <textarea className="kos-input artifact-dialog-about" rows={2} maxLength={RENAME_DESCRIPTION_MAX} value={dialog.description} onChange={(e) => setDialog({ ...dialog, description: e.target.value })} />
              </Field>
            )}
            <div className="file-dialog-actions">
              <button type="submit" className="btn btn--primary" disabled={busy || !dialog.title.trim()}>
                Save
              </button>
              <button type="button" className="btn" onClick={() => setDialog(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={moving} title={moving ? `Move “${dialog.record.title}”` : "Move"} onClose={() => setDialog(null)}>
        {dialog?.kind === "move" && (
          <form
            className="file-dialog artifact-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              const place = places.find((p) => p.key === dialog.choice);
              if (!place) return;
              const { record } = dialog;
              void run(() => did("move", api.moveArtifact(record.id, place.to)));
            }}
          >
            <p className="hint">It keeps its id and its versions, so mentions and links still find it. Its new owner is where it lives and who KOS asks about it.</p>
            <div className="artifact-move-list" role="radiogroup" aria-label="Move to">
              {places.map((p) => {
                const here = p.key === placeKey(dialog.record);
                const chosen = p.key === dialog.choice;
                return (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    disabled={here}
                    className={`artifact-move-option${chosen ? " is-on" : ""}`}
                    onClick={() => setDialog({ ...dialog, choice: p.key })}
                  >
                    {p.mark}
                    <span className="artifact-move-name">{p.label}</span>
                    {here && <span className="artifact-move-here">Here now</span>}
                  </button>
                );
              })}
            </div>
            <div className="file-dialog-actions">
              <button type="submit" className="btn btn--primary" disabled={busy || !dialog.choice}>
                Move
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

  return { items, restore, remove, busy, dialogs };
}

/** Bring an artifact back from the trash from anywhere that names it (a chat's card), for every card that shows it. */
export function restoreFromTrash(id: string): Promise<PageSummary> {
  return api.restoreArtifact(id).then((record) => {
    trashChanged();
    return record;
  });
}

/** What a trashed artifact says where it is shown: that it is in the trash, with Restore and Delete forever for the owner. */
export function TrashNotice({ record, ops }: { record: PageSummary; ops: Pick<ArtifactOps, "restore" | "remove" | "busy"> }): ReactElement {
  return (
    <div className="ops-alert artifact-trashed" role="status">
      <span>
        This artifact is in the trash{record.trashedAt ? ` (moved there ${relativeWords(Math.round(record.trashedAt / 1000))})` : ""}. It stays as it is until you restore it or delete it for good.
      </span>
      <span className="artifact-preview-acts">
        <ConfirmButton className="btn btn--sm btn--danger" label="Delete forever" text={deleteWords(record.title)} disabled={ops.busy} onConfirm={() => ops.remove(record)} />
        <button type="button" className="btn btn--primary btn--sm" disabled={ops.busy} onClick={() => ops.restore(record)}>
          Restore
        </button>
      </span>
    </div>
  );
}
