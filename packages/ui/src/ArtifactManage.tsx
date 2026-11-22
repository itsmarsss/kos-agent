import { Face, Field, NavIcon, PlacePicker, SheetFoot, WorkingDots, spring, type Place } from "@kos/kit";
import { checkName, EXPORT_WORDS, KIND_EXPORTS, RENAME_DESCRIPTION_MAX, RENAME_TITLE_MAX, WORKSPACE_SCOPE, sheetDataOf, type ExportFormat, type HtmlPage, slugWords, timeWords } from "@kos/shared";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { api, fieldErrorOf, type PageSummary, type Project } from "./api.js";
import type { MenuItem } from "./ArtifactHead.js";
import { ConfirmButton } from "./kit.js";
import { Modal } from "./Modal.js";
import { ProjectMark } from "./ProjectMark.js";

/**
 * The owner's own handles on an artifact, wherever it is shown (its viewer's
 * menu, a gallery card's): rename it, copy it, give it to another owner,
 * export it as a file, put it in the trash, and from the trash restore it or
 * delete it for good. One
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

/** Where an artifact can go: the kit's place, and the owner it means to the host. */
interface Destination extends Place {
  to: { project: string } | { blob: string };
}

/** The two dialogs' forms, for their sheets' primaries. */
const RENAME_FORM = "artifact-rename-form";
const MOVE_FORM = "artifact-move-form";

/** Where it is now, as a place's key; a removed blob's is no living blob's place, so none is marked. */
const placeKey = (r: Pick<PageSummary, "projectSlug" | "blob" | "blobRemoved">): string =>
  r.blob ? (r.blobRemoved ? "removed" : `blob:${r.blob}`) : r.projectSlug ? `project:${r.projectSlug}` : "workspace";

/** What "Delete forever" says before it goes. */
export const deleteWords = (title: string): string => `Delete “${title}” for good, with every version? This cannot be undone.`;

/** What "Empty trash" says before everything in it goes, naming what the view's filters hide, which goes too. */
export function emptyWords(n: number, hidden = 0): string {
  const one = n === 1;
  const what = one ? "the one artifact" : `all ${n} artifacts`;
  const unseen = hidden === 0 ? "" : one ? ", though your filters hide it" : `, including ${hidden} your filters hide`;
  return `Delete ${what} in the trash for good${unseen}? Every version goes with ${one ? "it" : "them"}. This cannot be undone.`;
}

type Dialog = { kind: "rename"; record: PageSummary; title: string; description: string; refused?: string } | { kind: "move"; record: PageSummary; choice?: string };

/** A sheet's tabs by name, read from its document when the view has it; none when it cannot be read. */
export function sheetTabs(page: HtmlPage | undefined): string[] {
  if (page?.kind !== "sheet") return [];
  try {
    const book = JSON.parse(sheetDataOf(page.html) ?? "") as { sheets?: { name?: unknown }[] };
    return (book.sheets ?? []).flatMap((t) => (typeof t.name === "string" ? [t.name] : []));
  } catch {
    return [];
  }
}

/**
 * The formats an artifact exports as, one item each, as its kind has them
 * (KIND_EXPORTS): a doc's PDF, Markdown and HTML, a deck's PDF and HTML, a
 * page's PDF and HTML, a sheet's CSV and HTML. A sheet whose tabs are known
 * (the viewer has its document) offers each tab's CSV beside all of them.
 */
export function exportItems(record: PageSummary, page: HtmlPage | undefined, act: (format: ExportFormat, tab?: string) => void): MenuItem[] {
  if (record.kind !== "html" || record.trashedAt !== undefined) return [];
  const tabs = sheetTabs(page);
  return KIND_EXPORTS[record.artifactKind].flatMap((format): MenuItem[] =>
    format === "csv" && tabs.length > 1
      ? [{ label: "Export all tabs as CSV", act: () => act("csv") }, ...tabs.map((tab) => ({ label: `Export “${tab}” as CSV`, act: () => act("csv", tab) }))]
      : [{ label: `Export as ${EXPORT_WORDS[format]}`, act: () => act(format) }],
  );
}

/** The dashboard's palette now: an HTML export is drawn in it; a PDF is printed light. */
const drawnTheme = (): "light" | "dark" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export interface ArtifactOps {
  /** The menu's management: rename, duplicate, move, export and trash; restore and delete forever for one in the trash. Given its document, a sheet's tabs export one by one too. */
  items: (record: PageSummary, page?: HtmlPage) => MenuItem[];
  restore: (record: PageSummary) => void;
  remove: (record: PageSummary) => void;
  /** Delete everything given for good, one at a time, each said as it goes; the first failure stops the rest. */
  empty: (records: PageSummary[]) => void;
  busy: boolean;
  /** The dialogs, drawn once by the view. */
  dialogs: ReactNode;
}

export function useArtifactOps({ projects, onChanged, onError }: { projects: Project[]; onChanged: (change: ArtifactChange) => void; onError: (text: string) => void }): ArtifactOps {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  /** The export being made, said while the server draws or prints it: a PDF can take a few seconds. */
  const [exporting, setExporting] = useState<string>();
  /** What was just done that has nowhere else to say so (a restore), for a moment. */
  const [said, setSaid] = useState<string>();
  useEffect(() => {
    if (!said) return;
    const t = window.setTimeout(() => setSaid(undefined), 3200);
    return () => window.clearTimeout(t);
  }, [said]);
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
      // A title refused goes under the title, where the owner is typing it.
      const onTitle = fieldErrorOf(err, "name");
      if (onTitle) return setDialog((d) => (d?.kind === "rename" ? { ...d, refused: onTitle } : d));
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const did = (op: Exclude<ArtifactChange["op"], "delete">, work: Promise<PageSummary>): Promise<ArtifactChange> => work.then((record) => ({ op, record }));

  const restore = (record: PageSummary): void =>
    void run(() =>
      did("restore", api.restoreArtifact(record.id)).then((change) => {
        setSaid(`Restored “${record.title}”`);
        return change;
      }),
    );
  const remove = (record: PageSummary): void => void run(() => api.deleteArtifact(record.id).then(() => ({ op: "delete", id: record.id })));
  const empty = (records: PageSummary[]): void => {
    if (busy || records.length === 0) return;
    setBusy(true);
    void (async () => {
      try {
        for (const record of records) {
          await api.deleteArtifact(record.id);
          onChanged({ op: "delete", id: record.id });
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        trashChanged();
        setBusy(false);
      }
    })();
  };

  const exportAs = (record: PageSummary, format: ExportFormat, tab?: string): void => {
    if (exporting) return;
    setExporting(`Exporting “${tab ?? record.title}” as ${EXPORT_WORDS[format]}`);
    void api
      .exportArtifact(record.id, format, { ...(tab !== undefined ? { tab } : {}), theme: format === "pdf" ? "light" : drawnTheme() })
      .catch((err: unknown) => onError(`Could not export “${record.title}”: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setExporting(undefined));
  };
  const exports = (record: PageSummary, page?: HtmlPage): MenuItem[] => exportItems(record, page, (format, tab) => exportAs(record, format, tab)).map((item, i) => (i === 0 ? { ...item, divided: true } : item));

  const items = (record: PageSummary, page?: HtmlPage): MenuItem[] =>
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
          ...exports(record, page),
          { label: "Move to Trash", act: () => void run(() => did("trash", api.trashArtifact(record.id))), danger: true, divided: true },
        ];

  const places: Destination[] = [
    {
      id: "workspace",
      to: { project: WORKSPACE_SCOPE },
      name: "Workspace",
      group: "workspace",
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
      .map((p): Destination => ({ id: `project:${p.slug}`, to: { project: p.slug }, name: p.name, group: "project", mark: <ProjectMark slug={p.slug} name={p.name} colour={p.colour} /> })),
    ...blobs.map((name): Destination => ({ id: `blob:${name}`, to: { blob: name }, name: slugWords(name), group: "blob", mark: <Face seed={name} size={20} /> })),
  ];

  const titleError = dialog?.kind === "rename" ? (dialog.refused ?? checkName(dialog.title, { noun: "artifact", max: RENAME_TITLE_MAX })?.message ?? null) : null;
  const dialogs = (
    <>
      <AnimatePresence>
        {exporting && (
          <m.div
            key="exporting"
            className="ops-toast"
            role="status"
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={spring}
          >
            <span className="ops-toast-text">{exporting}</span>
            <WorkingDots />
          </m.div>
        )}
        {said && !exporting && (
          <m.div key="said" className="ops-toast" role="status" initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.98 }} transition={spring}>
            <span className="ops-toast-text">{said}</span>
          </m.div>
        )}
      </AnimatePresence>
      <Modal
        open={dialog?.kind === "rename"}
        title="Rename"
        size="sm"
        onClose={() => setDialog(null)}
        footer={
          dialog?.kind === "rename" && (
            <SheetFoot
              onCancel={() => setDialog(null)}
              primary={
                <button type="submit" form={RENAME_FORM} className="btn btn--primary" disabled={busy || titleError !== null}>
                  Save
                </button>
              }
            />
          )
        }
      >
        {dialog?.kind === "rename" && (
          <form
            id={RENAME_FORM}
            className="artifact-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              const title = dialog.title.trim();
              if (titleError) return;
              const { record } = dialog;
              // Only what changed: an older widget page has no description to send.
              const description = dialog.description.trim();
              const change = { ...(title !== record.title ? { title } : {}), ...(description !== (record.description ?? "") ? { description } : {}) };
              if (!("title" in change) && !("description" in change)) return setDialog(null);
              void run(() => did("rename", api.renameArtifact(record.id, change)));
            }}
          >
            <Field label="Title" error={titleError}>
              <input className="kos-input" value={dialog.title} autoFocus aria-invalid={titleError !== null} onFocus={(e) => e.target.select()} onChange={(e) => setDialog({ kind: "rename", record: dialog.record, description: dialog.description, title: e.target.value })} />
            </Field>
            {dialog.record.kind === "html" && (
              <Field label="Description" hint="One sentence: what it is for.">
                <textarea className="kos-input artifact-dialog-about" rows={3} maxLength={RENAME_DESCRIPTION_MAX} value={dialog.description} onChange={(e) => setDialog({ ...dialog, description: e.target.value })} />
              </Field>
            )}
          </form>
        )}
      </Modal>

      <Modal
        open={moving}
        title={moving ? `Move “${dialog.record.title}”` : "Move"}
        size="sm"
        onClose={() => setDialog(null)}
        footer={
          dialog?.kind === "move" && (
            <SheetFoot
              onCancel={() => setDialog(null)}
              primary={
                <button type="submit" form={MOVE_FORM} className="btn btn--primary" disabled={busy || !dialog.choice}>
                  Move
                </button>
              }
            />
          )
        }
      >
        {dialog?.kind === "move" && (
          <form
            id={MOVE_FORM}
            className="artifact-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              const place = places.find((p) => p.id === dialog.choice);
              if (!place) return;
              const { record } = dialog;
              void run(() => did("move", api.moveArtifact(record.id, place.to)));
            }}
          >
            <p className="hint">It keeps its id and its versions, so mentions and links still find it. Its new owner is where it lives and who KOS asks about it.</p>
            <PlacePicker places={places} current={placeKey(dialog.record)} value={dialog.choice ?? null} onChoose={(choice) => setDialog({ kind: "move", record: dialog.record, ...(choice ? { choice } : {}) })} />
          </form>
        )}
      </Modal>
    </>
  );

  return { items, restore, remove, empty, busy, dialogs };
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
        This artifact is in the trash{record.trashedAt ? ` (moved there ${timeWords(record.trashedAt)})` : ""}. It stays as it is until you restore it or delete it for good.
      </span>
      <span className="artifact-preview-acts">
        <ConfirmButton className="btn btn--sm btn--danger" label="Delete forever" text={deleteWords(record.title)} disabled={ops.busy} onConfirm={() => ops.remove(record)} />
        <button type="button" className="btn btn--sm" disabled={ops.busy} onClick={() => ops.restore(record)}>
          Restore
        </button>
      </span>
    </div>
  );
}
