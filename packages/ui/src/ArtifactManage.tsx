import { CheckIcon, Face, Field, NavIcon, WorkingDots, spring } from "@kos/kit";
import { EXPORT_WORDS, KIND_EXPORTS, RENAME_DESCRIPTION_MAX, RENAME_TITLE_MAX, WORKSPACE_SCOPE, relativeWords, sheetDataOf, type ExportFormat, type HtmlPage } from "@kos/shared";
import { AnimatePresence, m } from "motion/react";
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { api, type PageSummary, type Project } from "./api.js";
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

/** Where an artifact can go, as the move picker lists it, under its group's name. */
interface Place {
  key: string;
  to: { project: string } | { blob: string };
  label: string;
  mark: ReactNode;
  group: "Workspace" | "Projects" | "Blobs";
}

/** The move picker's groups, in its order. */
const GROUPS: readonly Place["group"][] = ["Workspace", "Projects", "Blobs"];

/** How many places the move picker lists before it offers a search over them. */
const FIND_FROM = 8;

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

type Dialog = { kind: "rename"; record: PageSummary; title: string; description: string } | { kind: "move"; record: PageSummary; choice?: string };

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
          { label: "Move to trash", act: () => void run(() => did("trash", api.trashArtifact(record.id))), danger: true, divided: true },
        ];

  const places: Place[] = [
    {
      key: "workspace",
      to: { project: WORKSPACE_SCOPE },
      label: "Workspace",
      group: "Workspace",
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
      .map((p): Place => ({ key: `project:${p.slug}`, to: { project: p.slug }, label: p.name, group: "Projects", mark: <ProjectMark slug={p.slug} name={p.name} colour={p.colour} /> })),
    ...blobs.map((name): Place => ({ key: `blob:${name}`, to: { blob: name }, label: name, group: "Blobs", mark: <Face seed={name} size={20} /> })),
  ];

  const dialogs = (
    <>
      <AnimatePresence>
        {exporting && (
          <m.div
            key="exporting"
            className="ops-toast"
            role="status"
            initial={{ opacity: 0, y: -10, x: "-50%", scale: 0.97 }}
            animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
            exit={{ opacity: 0, y: -6, x: "-50%", scale: 0.98 }}
            transition={spring}
          >
            <span className="ops-toast-text">{exporting}</span>
            <WorkingDots />
          </m.div>
        )}
      </AnimatePresence>
      <Modal open={dialog?.kind === "rename"} title="Rename" size="sm" onClose={() => setDialog(null)}>
        {dialog?.kind === "rename" && (
          <form
            className="artifact-dialog"
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
                <textarea className="kos-input artifact-dialog-about" rows={3} maxLength={RENAME_DESCRIPTION_MAX} value={dialog.description} onChange={(e) => setDialog({ ...dialog, description: e.target.value })} />
              </Field>
            )}
            <div className="artifact-dialog-actions">
              <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy || !dialog.title.trim()}>
                Save
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={moving} title={moving ? `Move “${dialog.record.title}”` : "Move"} size="sm" onClose={() => setDialog(null)}>
        {dialog?.kind === "move" && (
          <form
            className="artifact-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              const place = places.find((p) => p.key === dialog.choice);
              if (!place) return;
              const { record } = dialog;
              void run(() => did("move", api.moveArtifact(record.id, place.to)));
            }}
          >
            <p className="hint">It keeps its id and its versions, so mentions and links still find it. Its new owner is where it lives and who KOS asks about it.</p>
            <MovePicker places={places} here={placeKey(dialog.record)} {...(dialog.choice ? { choice: dialog.choice } : {})} onChoose={(choice) => setDialog({ kind: "move", record: dialog.record, ...(choice ? { choice } : {}) })} />
            <div className="artifact-dialog-actions">
              <button type="button" className="btn btn--ghost" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy || !dialog.choice}>
                Move
              </button>
            </div>
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

/**
 * Where a move goes, as one radio group under each group's name: one stop on
 * the tab key (the place chosen, else the first that can be), the arrows walk
 * the places and choose as they go, Home and End go to the ends. Where it is
 * now is shown, not offered. A long list gets a search over it.
 */
function MovePicker({ places, here, choice, onChoose }: { places: Place[]; here: string; choice?: string; onChoose: (key: string | undefined) => void }): ReactElement {
  const list = useRef<HTMLDivElement>(null);
  const ids = useId();
  const [find, setFind] = useState("");
  const q = find.trim().toLowerCase();
  const shown = q ? places.filter((p) => p.label.toLowerCase().includes(q)) : places;
  // A place the search hides is not where Move goes: the choice is let go, and Move waits for another.
  const hidden = choice !== undefined && !shown.some((p) => p.key === choice);
  useEffect(() => {
    if (hidden) onChoose(undefined);
  }, [hidden]);
  const open = shown.filter((p) => p.key !== here);
  const stop = open.some((p) => p.key === choice) ? choice : open[0]?.key;
  const keys = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = open.findIndex((p) => p.key === stop);
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? open.length - 1 : step ? (at + step + open.length) % open.length : -1;
    const next = open[to];
    if (!next) return;
    e.preventDefault();
    onChoose(next.key);
    [...(list.current?.querySelectorAll<HTMLElement>("[data-place]") ?? [])].find((el) => el.dataset.place === next.key)?.focus();
  };
  return (
    <div className="artifact-move">
      {places.length > FIND_FROM && (
        <input className="kos-input artifact-move-find" type="search" placeholder="Find a place" aria-label="Find a place" value={find} onChange={(e) => setFind(e.target.value)} />
      )}
      <div className="artifact-move-list" role="radiogroup" aria-label="Move to" ref={list} onKeyDown={keys}>
        {shown.length === 0 && <p className="empty-line">Nowhere by that name.</p>}
        {GROUPS.map((group) => {
          const inGroup = shown.filter((p) => p.group === group);
          if (inGroup.length === 0) return null;
          const options = inGroup.map((p) => {
            const isHere = p.key === here;
            const chosen = p.key === choice;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                data-place={p.key}
                aria-checked={chosen}
                disabled={isHere}
                tabIndex={p.key === stop ? 0 : -1}
                className={`artifact-move-option${chosen ? " is-on" : ""}`}
                onClick={() => onChoose(p.key)}
              >
                {p.mark}
                <span className="artifact-move-name">{p.label}</span>
                {isHere && <span className="artifact-move-here">Here now</span>}
                {chosen && <CheckIcon size={14} title="" />}
              </button>
            );
          });
          // The workspace is one place, not a group of them.
          return group === "Workspace" ? (
            <Fragment key={group}>{options}</Fragment>
          ) : (
            <div key={group} role="group" aria-labelledby={`${ids}-${group}`} className="artifact-move-group-list">
              <p className="label artifact-move-group" id={`${ids}-${group}`}>
                {group}
              </p>
              {options}
            </div>
          );
        })}
      </div>
    </div>
  );
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
