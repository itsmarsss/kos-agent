import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";

import { EmptyState, NavIcon, SheetFoot, useOverlayScroll } from "@kos/kit";

import { Toast } from "../Toast.js";
import { api, type Attachment, type DirEntry, type FileSearch, type Project } from "../api.js";
import { Drawer } from "../Drawer.js";
import { ProjectMark } from "../ProjectMark.js";
import { Select } from "../Select.js";
import { FileIcon } from "../FileIcon.js";
import { FilePreview } from "../FilePreview.js";
import { ColumnsView, type Column } from "./ColumnsView.js";
import { FileFacts } from "./FileFacts.js";
import { GalleryView } from "./GalleryView.js";
import { FILES_LAYOUT, PANEL_LAYOUT } from "./columns.js";
import { ListView, type ListRow } from "./ListView.js";
import { FinderMenu, type MenuItem } from "./Menu.js";
import { EMPTY_SELECTION, clickSelect, freeName, kindOf, moveLead, nameOf, only, parentOf, releaseSelect, rememberView, sortBy, sortEntries, trail, typeSelect, viewFor, within, type FinderView, type Selection, type Sort } from "./model.js";
import { MoveDialog } from "./MoveDialog.js";
import { NewFolderDialog } from "./NewFolderDialog.js";
import { useFinderOps } from "./ops.js";
import { Crumbs, pathWords, type Crumb } from "./Crumbs.js";
import { PathBar } from "./PathBar.js";
import { reveal } from "./reveal.js";
import { rowId, type RowHandlers } from "./rows.js";
import { Sidebar, samePlace, type Place } from "./Sidebar.js";
import { SORT_CHOICES, Toolbar } from "./Toolbar.js";
import { TrashView } from "./TrashView.js";
import { useFolders } from "./useFolders.js";

/**
 * The workspace's files, kept the way Finder keeps a Mac's: a sidebar of
 * places, a folder as a list, columns or icons, a path at the foot, Quick
 * Look on Space, selection and keys as Finder has them, and the trash. The
 * Files page shows it over the whole workspace; a project's page shows it
 * over the project's folder, without the sidebar, in a narrow column. Every
 * change goes through the server's jailed routes.
 */

export interface FinderProps {
  /** The folder it is kept inside: "." for the workspace, a project's folder. */
  root?: string;
  rootName?: string;
  /** The folder to show; a change from outside (the address) goes there. */
  path?: string;
  /** A file to choose and look at on arrival. */
  focus?: string;
  /** The line of `focus` to show lit when it is looked at: where a search found it. */
  focusLine?: number;
  /** Told of each folder it goes to, for the address. */
  onNavigate?: (path: string) => void;
  sidebar?: boolean;
  /** How a file gets in; the workspace's upload route when absent. */
  upload?: (file: Attachment, dir: string) => Promise<unknown>;
  /** Ask KOS about these, in a chat with them referenced. */
  onAsk?: (paths: string[]) => void;
  onOpenInFiles?: (path: string) => void;
  /** Something changed that the rest of the dashboard lists too. */
  onChanged?: () => void;
  /** Off screen: nothing is read until it is back. */
  paused?: boolean;
}

/** The type a dragged row carries: workspace paths, so a drop from the desktop is not mistaken for one. */
const DRAG_TYPE = "application/x-kos-paths";
const SORT_KEY = "kos.finder.sort";
/** Whether KOS's own files (kos.sqlite, profile.json) are listed: hidden unless the owner asks, remembered per browser. */
const OWN_KEY = "kos.finder.showOwn";
/** Below this the finder is one column: no sidebar, no columns view, the preview a sheet. */
const NARROW_PX = 640;
const TYPE_RESET_MS = 900;
const VIEW_WORDS: Record<FinderView, string> = { list: "as List", columns: "as Columns", gallery: "as Icons" };

function readShowOwn(): boolean {
  try {
    return localStorage.getItem(OWN_KEY) === "1";
  } catch {
    return false;
  }
}

function readSort(): Sort {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as Sort | null;
    if (s && ["name", "modified", "size", "kind"].includes(s.key)) return { key: s.key, desc: !!s.desc };
  } catch {
    // A default is fine.
  }
  return { key: "name", desc: false };
}

const carriesPaths = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);

/**
 * The drag this page started, by a token it made: a drop carrying our type
 * from anywhere else (another site's page, a crafted drag) names paths this
 * page never chose, and moves nothing.
 */
let dragging: string | null = null;

/** The paths a drop carries, only when they are this page's own drag. */
function droppedPaths(e: DragEvent): string[] | undefined {
  try {
    const got = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { token?: unknown; paths?: unknown };
    if (!dragging || got.token !== dragging || !Array.isArray(got.paths) || !got.paths.every((p) => typeof p === "string")) return undefined;
    return got.paths as string[];
  } catch {
    return undefined;
  }
}
const carriesFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes("Files");

export function Finder({ root = ".", rootName = "Workspace", path, focus, focusLine, onNavigate, sidebar = true, upload, onAsk, onOpenInFiles, onChanged, paused = false }: FinderProps): ReactElement {
  const start: Place = { kind: "folder", path: path && within(path, root) ? path : root };
  const [history, setHistory] = useState<{ list: Place[]; at: number }>({ list: [start], at: 0 });
  const place = history.list[history.at]!;
  const folder = place.kind === "folder" ? place.path : root;

  const frame = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const mainScroll = useOverlayScroll(main);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const seen = new ResizeObserver(([r]) => setNarrow((r?.contentRect.width ?? 1000) < NARROW_PX));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  const [chosenView, setChosenView] = useState<FinderView>(() => viewFor(folder, "list"));
  useEffect(() => setChosenView(viewFor(folder, "list")), [folder]);
  const view: FinderView = narrow && chosenView === "columns" ? "list" : chosenView;
  const [sort, setSortState] = useState<Sort>(readSort);
  const [showOwn, setShowOwnState] = useState(readShowOwn);
  const setShowOwn = (on: boolean): void => {
    setShowOwnState(on);
    try {
      localStorage.setItem(OWN_KEY, on ? "1" : "0");
    } catch {
      // For this visit only.
    }
  };
  const setSort = (s: Sort): void => {
    setSortState(s);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(s));
    } catch {
      // As above.
    }
  };

  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [infoPath, setInfoPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[]; label: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [dragged, setDragged] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [contents, setContents] = useState(false);
  const [found, setFound] = useState<FileSearch | null>(null);
  const [recents, setRecents] = useState<DirEntry[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [trashTick, setTrashTick] = useState(0);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  /** In columns, the chosen folder whose contents show in the next column. */
  const [leadDir, setLeadDir] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  /** What to choose on arriving somewhere: the folder just come up out of, as Finder does. */
  const arriving = useRef<string | null>(null);

  // Somewhere else is a fresh start: nothing open in place, no search, and nothing chosen but what was come out of.
  useEffect(() => {
    setSel(arriving.current ? only(arriving.current) : EMPTY_SELECTION);
    arriving.current = null;
    setExpanded(new Set());
    setEditing(null);
    setQuery("");
    setFound(null);
  }, [place]);

  // The address moved (back in the browser, a link): go there too.
  useEffect(() => {
    if (path === undefined || !within(path, root) || (place.kind === "folder" && place.path === path)) return;
    go({ kind: "folder", path });
    // Only a change of the address is followed, not every render.
  }, [path]);

  // A file asked for by the address: chosen, and looked at, once its folder is the one shown.
  useEffect(() => {
    if (!focus || place.kind !== "folder" || parentOf(focus) !== place.path) return;
    setSel(only(focus));
    setLooking(true);
  }, [focus, place]);

  const go = (next: Place): void => {
    setHistory((h) => (samePlace(h.list[h.at]!, next) ? h : { list: [...h.list.slice(0, h.at + 1), next], at: h.at + 1 }));
    setLooking(false);
    if (next.kind === "folder") onNavigate?.(next.path);
  };
  const step = (by: number): (() => void) | undefined => {
    const at = history.at + by;
    if (at < 0 || at >= history.list.length) return undefined;
    return () => {
      setHistory((h) => ({ ...h, at }));
      const next = history.list[at]!;
      if (next.kind === "folder") onNavigate?.(next.path);
    };
  };

  /* What is on screen, folder by folder. */

  const columnDirs = useMemo(() => {
    if (view !== "columns" || place.kind !== "folder") return [folder];
    const lead = sel.lead && within(sel.lead, folder) && sel.lead !== folder ? sel.lead : null;
    if (!lead) return [folder];
    return trail(parentOf(lead), folder, "").map((s) => s.path);
  }, [view, place.kind, folder, sel.lead]);

  const visible = useMemo(() => {
    const dirs = place.kind === "folder" ? (view === "list" ? [folder, ...[...expanded].filter((d) => within(d, folder))] : view === "columns" ? [...columnDirs, ...(leadDir ? [leadDir] : [])] : [folder]) : [];
    if (sidebar) dirs.push(".");
    return [...new Set(dirs)];
  }, [place.kind, view, folder, expanded, columnDirs, leadDir, sidebar]);
  const folders = useFolders(visible, paused);
  const entriesOf = (dir: string): DirEntry[] | undefined => {
    const got = folders.get(dir).entries;
    return got ? sortEntries(got.filter((e) => !e.name.startsWith(".") && (showOwn || !e.reserved)), sort) : undefined;
  };

  // The lead's own entry, when it is a folder in columns: its column shows next.
  const leadEntryDir = view === "columns" && sel.lead ? folders.get(parentOf(sel.lead)).entries?.find((e) => e.path === sel.lead && e.kind === "dir") : undefined;
  const columns: Column[] = [...columnDirs, ...(leadEntryDir ? [leadEntryDir.path] : [])].map((dir, i, all) => {
    const state = folders.get(dir);
    const entries = entriesOf(dir);
    return { path: dir, entries, ...(state.error ? { error: state.error } : {}), chosen: all[i + 1] ?? (sel.lead && parentOf(sel.lead) === dir ? sel.lead : null) };
  });
  useEffect(() => setLeadDir(leadEntryDir?.path ?? null), [leadEntryDir?.path]);

  // Recents and the projects, read when wanted.
  useEffect(() => {
    if (place.kind !== "recents" || paused) return;
    void api.recentFiles().then((r) => setRecents(r.entries)).catch(() => setRecents([]));
  }, [place.kind, paused]);
  useEffect(() => {
    if (!sidebar) return;
    void api.projects().then((p) => setProjects(p.filter((x) => x.status !== "archived"))).catch(() => setProjects([]));
  }, [sidebar]);

  // A search runs a moment after the typing stops, over this folder and below.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFound(null);
      return undefined;
    }
    const ask = new AbortController();
    const t = setTimeout(() => {
      void api
        .searchFiles(place.kind === "folder" ? folder : root, q, contents, ask.signal)
        .then((r) => !ask.signal.aborted && setFound(r))
        .catch(() => !ask.signal.aborted && setFound({ entries: [], truncated: false }));
    }, 220);
    return () => {
      ask.abort();
      clearTimeout(t);
    };
  }, [query, contents, folder, place.kind, root]);

  /** The folder a search's or Recents' row is in, named as the path bar names it: from this Finder's root, not the workspace's. */
  const whereOf = (path: string): { name: string; path: string } => {
    const steps = trail(parentOf(path), root, rootName);
    return { name: steps.at(-1)?.name ?? rootName, path: pathWords(steps.map((s) => s.name)) };
  };
  /** The rows in the order they are drawn: what the keys move through. */
  const listRows: ListRow[] = ((): ListRow[] => {
    if (found) return sortEntries(found.entries, sort).map((e) => ({ entry: e, depth: 0, where: whereOf(e.path), ...(e.text ? { match: `Line ${e.line}: ${e.text}` } : {}) }));
    if (place.kind === "recents") return (recents ?? []).map((e) => ({ entry: e, depth: 0, where: whereOf(e.path) }));
    const rows: ListRow[] = [];
    const add = (dir: string, depth: number): void => {
      for (const e of entriesOf(dir) ?? []) {
        const open = e.kind === "dir" ? expanded.has(e.path) : undefined;
        rows.push({ entry: e, depth, ...(open !== undefined ? { open } : {}) });
        if (open) add(e.path, depth + 1);
      }
    };
    add(folder, 0);
    return rows;
  })();
  const leadColumn = view === "columns" && !found ? columns.find((c) => sel.lead && c.entries?.some((e) => e.path === sel.lead)) ?? columns[0] : undefined;
  const ordered: DirEntry[] = view === "columns" && !found && place.kind === "folder" ? (leadColumn?.entries ?? []) : view === "gallery" && !found && place.kind === "folder" ? (entriesOf(folder) ?? []) : listRows.map((r) => r.entry);
  const order = ordered.map((e) => e.path);
  const byPath = new Map<string, DirEntry>();
  for (const r of listRows) byPath.set(r.entry.path, r.entry);
  for (const c of columns) for (const e of c.entries ?? []) byPath.set(e.path, e);
  const chosen = sel.paths.map((p) => byPath.get(p)).filter((e): e is DirEntry => !!e);
  const lead = sel.lead ? byPath.get(sel.lead) : undefined;
  /** The list's chosen row, by its id, for a reader to hear as the arrows move it (the list view's rows carry ids). */
  const activeRow = lead && (view === "list" || found) && order.includes(lead.path) ? rowId(lead.path) : undefined;
  const files = ordered.filter((e) => e.kind === "file").map((e) => e.path);
  /** Where a new folder or an upload goes: the folder shown, or in columns the deepest one open. */
  const here = view === "columns" && place.kind === "folder" ? (leadEntryDir?.path ?? columnDirs[columnDirs.length - 1] ?? folder) : folder;

  // The lead row kept in view as the keys move it.
  useEffect(() => {
    if (!sel.lead) return;
    const lead = sel.lead;
    const row = [...(main.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find((el) => el.dataset.path === lead);
    if (row) reveal(row);
  }, [sel.lead]);

  const ops = useFinderOps({
    onChanged: () => {
      folders.reload();
      setTrashTick((t) => t + 1);
      if (place.kind === "recents") void api.recentFiles().then((r) => setRecents(r.entries));
      onChanged?.();
    },
    ...(upload ? { send: upload } : {}),
  });

  /* Doing things to what is chosen. */

  /** The name the new-folder dialog offers, while it is open: at the workspace's top level a folder is named before it is made. */
  const [naming, setNaming] = useState<string | null>(null);
  const startNewFolder = async (): Promise<void> => {
    const name = freeName((entriesOf(here) ?? []).map((e) => e.name), "untitled folder");
    if (here === ".") {
      setNaming(name);
      return;
    }
    const made = await ops.newFolder(here, name);
    if (made) {
      if (view === "list" && here !== folder) setExpanded((x) => new Set(x).add(here));
      setSel(only(made));
      setEditing(made);
    }
  };
  /** What is chosen, less KOS's own files, which nothing here may change. */
  const changeable = (paths: string[]): string[] => paths.filter((p) => !byPath.get(p)?.reserved);
  /** Copies of these, beside them, chosen once made so the next key acts on the copies, as in Finder. */
  const duplicate = (paths: string[]): void => {
    void ops.duplicate(paths).then((made) => {
      if (made.length) setSel({ paths: made, anchor: made[0]!, lead: made[made.length - 1]! });
    });
  };
  const trashChosen = (given = sel.paths): void => {
    const paths = changeable(given);
    if (!paths.length) return;
    setLooking(false);
    void ops.trash(paths).then(() => setSel(EMPTY_SELECTION));
  };
  const openEntry = (entry: DirEntry): void => {
    if (entry.kind === "dir") go({ kind: "folder", path: entry.path });
    else {
      setSel(only(entry.path));
      setLooking(true);
    }
  };
  const itemsFor = (entries: DirEntry[]): MenuItem[] => {
    const paths = entries.map((e) => e.path);
    const one = entries.length === 1 ? entries[0] : undefined;
    const filesChosen = entries.filter((e) => e.kind === "file");
    const items: MenuItem[] = [];
    if (one?.kind === "dir") items.push({ label: "Open", act: () => openEntry(one), keys: "⌘↓" });
    if (one?.kind === "file") items.push({ label: "Quick Look", act: () => openEntry(one), keys: "Space" });
    items.push({ label: "Get Info", act: () => setInfoPath(one ? one.path : paths[0] ?? null), keys: "⌘I", disabled: !one });
    // KOS's own files are looked at, never changed: no rename, duplicate, move or trash.
    const kept = entries.some((e) => e.reserved);
    if (!kept) {
      items.push({ label: "Rename", act: () => one && setEditing(one.path), divided: true, disabled: !one, keys: "↩" });
      items.push({ label: "Duplicate", act: () => duplicate(paths), keys: "⌘D" });
      items.push({ label: "Move to…", act: () => setMoving(paths) });
    }
    if (filesChosen.length) items.push({ label: filesChosen.length > 1 ? `Download ${filesChosen.length} files` : "Download", act: () => ops.download(filesChosen.map((e) => e.path)) });
    items.push({ label: paths.length > 1 ? "Copy paths" : "Copy path", act: () => ops.copyPath(paths) });
    if (onAsk) items.push({ label: "Ask KOS about this", act: () => onAsk(paths), divided: true });
    if (onOpenInFiles && one) items.push({ label: "Show in Files", act: () => onOpenInFiles(one.path), ...(onAsk ? {} : { divided: true }) });
    if (!kept) items.push({ label: "Move to trash", act: () => trashChosen(paths), danger: true, divided: true, keys: "⌘⌫" });
    // Said rather than left out: a menu with no Rename or Trash looked broken.
    else items.push({ label: "KOS's own file: it can't be renamed, moved or trashed", act: () => undefined, disabled: true, divided: true });
    return items;
  };
  /** The narrow bar's menu: how it is shown and sorted, then what the wide bar's buttons and Actions do. */
  const moreItems = (): MenuItem[] => {
    const views: MenuItem[] = place.kind === "folder" && !found ? (narrow ? (["list", "gallery"] as const) : (["list", "columns", "gallery"] as const)).map((v) => ({ label: VIEW_WORDS[v], act: () => pickView(v), checked: view === v })) : [];
    const sorts: MenuItem[] = SORT_CHOICES.map((c, i) => ({ label: `Sort by ${c.label}`, act: () => setSort(sortBy(sort, c.value)), checked: sort.key === c.value, keys: sort.key === c.value ? (sort.desc ? "↓" : "↑") : "", divided: i === 0 && views.length > 0 }));
    const acts = (chosen.length ? itemsFor(chosen) : place.kind === "folder" ? folderItems() : []).map((item, i) => (i === 0 ? { ...item, divided: true } : item));
    return [...views, ...sorts, ...acts];
  };
  /** The menu for what is chosen, or for the folder when nothing is: a right click, the menu key, Shift+F10. */
  const keyMenu = (): void => {
    const rowEl = sel.lead ? [...(main.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find((el) => el.dataset.path === sel.lead) : undefined;
    const r = (rowEl ?? main.current)?.getBoundingClientRect();
    const at = r ? { x: r.left + 24, y: rowEl ? r.bottom : r.top + 24 } : { x: 0, y: 0 };
    if (chosen.length) setMenu({ at, items: itemsFor(chosen), label: `Actions for ${chosen.length === 1 ? chosen[0]!.name : `${chosen.length} items`}` });
    else if (making) setMenu({ at, items: folderItems(), label: "Folder actions" });
  };
  const menuUnder = (button: HTMLElement, items: MenuItem[], label: string): void => {
    const r = button.getBoundingClientRect();
    setMenu({ at: { x: r.right, y: r.bottom + 4 }, items, label });
  };
  /** This folder holds KOS's own files (the workspace's root does), so the toggle that shows them is offered. */
  const holdsOwn = (folders.get(folder).entries ?? []).some((e) => e.reserved);
  const folderItems = (): MenuItem[] => [
    { label: "New Folder", act: () => void startNewFolder(), keys: "⇧⌘N" },
    { label: "Upload Files…", act: () => picker.current?.click() },
    { label: "Get Info", act: () => setInfoPath(here), divided: true },
    { label: "Copy path", act: () => ops.copyPath([here]) },
    ...(onAsk ? [{ label: "Ask KOS about this folder", act: () => onAsk([here]), divided: true }] : []),
    ...(holdsOwn ? [{ label: "Show KOS's files", act: () => setShowOwn(!showOwn), checked: showOwn, divided: true }] : []),
  ];

  /* The pointer, dragging, dropping. */

  const dropInto = (dir: string): ReturnType<RowHandlers["drop"]> => ({
    onDragOver: (e) => {
      if (byPath.get(dir)?.reserved || (!carriesPaths(e) && !carriesFiles(e))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = carriesPaths(e) ? "move" : "copy";
      setOver(dir);
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setOver((o) => (o === dir ? null : o));
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      if (carriesPaths(e)) {
        const paths = droppedPaths(e);
        if (paths) void ops.move(paths, dir);
      } else if (e.dataTransfer.files.length) void ops.upload(Array.from(e.dataTransfer.files), dir);
    },
  });

  const h: RowHandlers = {
    selected: new Set(sel.paths),
    lead: sel.lead,
    editing,
    over,
    dragged,
    // The press's own default puts the keys on the list as a pointer's focus; focusing it here drew the keyboard's ring round it.
    press: (e, entry) => {
      if (editing) return;
      // A press on what is already chosen keeps the choice, so it can be dragged as one.
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey && sel.paths.includes(entry.path)) {
        setSel((s) => ({ ...s, lead: entry.path, anchor: entry.path }));
        return;
      }
      setSel((s) => clickSelect(s, entry.path, order, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }));
    },
    release: (e, entry) => setSel((s) => releaseSelect(s, entry.path, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })),
    open: openEntry,
    menu: (at, entry) => {
      const keep = sel.paths.includes(entry.path);
      const entries = keep ? chosen : [entry];
      if (!keep) setSel(only(entry.path));
      setMenu({ at, items: itemsFor(entries), label: `Actions for ${entries.length === 1 ? entry.name : `${entries.length} items`}` });
    },
    renamed: (entry, name) => {
      setEditing(null);
      main.current?.focus({ preventScroll: true });
      if (name === null) return;
      void ops.rename(entry.path, name).then((to) => to && setSel(only(to)));
    },
    drag: (entry) => ({
      draggable: !entry.reserved,
      onDragStart: (e) => {
        const paths = changeable(sel.paths.includes(entry.path) ? sel.paths : [entry.path]);
        if (!paths.length) {
          e.preventDefault();
          return;
        }
        dragging = crypto.randomUUID();
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ token: dragging, paths }));
        e.dataTransfer.setData("text/plain", paths.join("\n"));
        e.dataTransfer.effectAllowed = "move";
        setDragged(new Set(paths));
      },
      // After the drop, if there was one: a later drop of the same data is no longer ours.
      onDragEnd: () => {
        dragging = null;
        setDragged(new Set());
      },
    }),
    drop: dropInto,
  };

  const dropOnTrash = {
    onDragOver: (e: DragEvent) => {
      if (!carriesPaths(e)) return;
      e.preventDefault();
      setOver("#trash");
    },
    onDragLeave: () => setOver((o) => (o === "#trash" ? null : o)),
    onDrop: (e: DragEvent) => {
      if (!carriesPaths(e)) return;
      e.preventDefault();
      setOver(null);
      const paths = droppedPaths(e);
      if (paths) trashChosen(paths);
    },
  };

  /* The keys, as Finder has them. */

  const tilesPerRow = (): number => {
    const tiles = [...(main.current?.querySelectorAll<HTMLElement>(".finder-tile") ?? [])];
    const top = tiles[0]?.offsetTop;
    const n = tiles.filter((t) => t.offsetTop === top).length;
    return Math.max(1, n);
  };
  const choose = (next: Selection): void => setSel(next);

  const onKey = (e: KeyboardEvent): void => {
    if (editing || place.kind === "trash") return;
    const meta = e.metaKey || e.ctrlKey;
    const leadEntry = lead;
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === " " && !meta) {
      handled();
      if (looking) setLooking(false);
      else if (leadEntry?.kind === "file") setLooking(true);
      return;
    }
    // An open sheet (Info, Move to) has Escape and its own keys; ⌘I shuts Info as it opened it.
    if (infoPath !== null || moving !== null) {
      if (infoPath !== null && meta && e.key.toLowerCase() === "i") {
        handled();
        setInfoPath(null);
      }
      return;
    }
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      handled();
      keyMenu();
      return;
    }
    // Escape takes back one thing here, and with nothing to take back is left to what holds the list (the side panel's drawer).
    if (e.key === "Escape") {
      if (looking) setLooking(false);
      else if (sel.paths.length) setSel(EMPTY_SELECTION);
      else return;
      handled();
      return;
    }
    if (e.key === "Enter" && !meta && leadEntry && !looking && !leadEntry.reserved) {
      handled();
      setEditing(leadEntry.path);
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && meta) {
      handled();
      trashChosen();
      return;
    }
    if (meta && (e.key === "ArrowDown" || e.key.toLowerCase() === "o")) {
      handled();
      if (leadEntry) openEntry(leadEntry);
      return;
    }
    if (meta && e.key === "ArrowUp") {
      handled();
      if (place.kind === "folder" && folder !== root) {
        arriving.current = folder;
        go({ kind: "folder", path: parentOf(folder) });
      }
      return;
    }
    if (meta && !e.shiftKey && e.key.toLowerCase() === "a") {
      handled();
      setSel({ paths: order, anchor: order[0] ?? null, lead: order[order.length - 1] ?? null });
      return;
    }
    if (meta && e.key.toLowerCase() === "i") {
      handled();
      setInfoPath(leadEntry?.path ?? here);
      return;
    }
    if (meta && e.key.toLowerCase() === "d") {
      handled();
      const paths = changeable(sel.paths);
      if (paths.length) duplicate(paths);
      return;
    }
    if (meta && e.shiftKey && e.key.toLowerCase() === "n") {
      handled();
      void startNewFolder();
      return;
    }
    if (meta && ["1", "2", "3"].includes(e.key)) {
      handled();
      pickView((["list", "columns", "gallery"] as const)[Number(e.key) - 1]!);
      return;
    }
    if (meta && (e.key === "[" || e.key === "]")) {
      handled();
      step(e.key === "[" ? -1 : 1)?.();
      return;
    }
    const gallery = view === "gallery" && !found && place.kind === "folder";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      handled();
      const by = gallery ? tilesPerRow() : 1;
      choose(moveLead(sel, order, e.key === "ArrowDown" ? by : -by, e.shiftKey));
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const right = e.key === "ArrowRight";
      if (gallery) {
        handled();
        choose(moveLead(sel, order, right ? 1 : -1, e.shiftKey));
      } else if (view === "columns" && !found && place.kind === "folder") {
        handled();
        if (right && leadEntry?.kind === "dir") {
          const first = entriesOf(leadEntry.path)?.[0];
          if (first) choose(only(first.path));
        } else if (!right && leadEntry && parentOf(leadEntry.path) !== folder) choose(only(parentOf(leadEntry.path)));
      } else if (view === "list" && leadEntry) {
        handled();
        if (leadEntry.kind === "dir" && right !== expanded.has(leadEntry.path)) {
          setExpanded((x) => {
            const next = new Set(x);
            if (right) next.add(leadEntry.path);
            else next.delete(leadEntry.path);
            return next;
          });
        } else if (!right && parentOf(leadEntry.path) !== folder && order.includes(parentOf(leadEntry.path))) choose(only(parentOf(leadEntry.path)));
      }
      return;
    }
    // Typing a name's first letters goes to it.
    if (e.key.length === 1 && !meta && !e.altKey && e.key !== " ") {
      const now = Date.now();
      typed.current = { text: now - typed.current.at > TYPE_RESET_MS ? e.key : typed.current.text + e.key, at: now };
      const hit = typeSelect(ordered, typed.current.text);
      if (hit) choose(only(hit));
      handled();
    }
  };

  const pickView = (v: FinderView): void => {
    setChosenView(v);
    rememberView(folder, v);
  };

  /* Drawing. */

  const top = (folders.get(".").entries ?? []).filter((e) => e.kind === "dir").map((e) => e.name);
  /** The top folders the owner's things may go in: not KOS's own (locks, .kos). */
  const topFolders = (folders.get(".").entries ?? []).filter((e) => e.kind === "dir" && !e.reserved).map((e) => e.name);
  const loading = place.kind === "folder" && !found && !folders.get(folder).entries && !folders.get(folder).error;
  const folderError = place.kind === "folder" ? folders.get(folder).error : undefined;
  const title = found ? `Searching “${query.trim()}”` : place.kind === "recents" ? "Recents" : place.kind === "trash" ? "Trash" : folder === root ? rootName : nameOf(folder);
  const emptyWords = place.kind === "recents" ? "Nothing has changed lately." : folderError ?? "This folder is empty.";
  /** An empty folder says how things get in; anything else just says what it found. */
  const empty =
    place.kind === "folder" && !found && !folderError ? (
      <>
        <FileIcon name="" kind="dir" size={30} />
        <span>{emptyWords}</span>
        <span className="finder-empty-hint">Drop files here, or use Upload.</span>
      </>
    ) : found ? (
      // A search that found nothing says so as every search does, with the one way back.
      <EmptyState variant="inline" query={{ noun: "files", onClear: () => setQuery("") }} />
    ) : (
      emptyWords
    );
  /** Still reading what to list: rows in its shape stand in for it. */
  const reading = !found && ((place.kind === "recents" && recents === null) || loading);
  const count = place.kind === "folder" && !found ? (entriesOf(folder)?.length ?? 0) : ordered.length;
  // Nothing counted while reading: "0 items" said the folder was empty before it had been read.
  const status = reading ? "" : `${sel.paths.length ? `${sel.paths.length} of ` : ""}${count} item${count === 1 ? "" : "s"}${found?.truncated ? ", search stopped early" : ""}`;
  const making = place.kind === "folder";
  const lookPath = looking && lead?.kind === "file" ? lead.path : null;
  const sidebarShown = sidebar && !narrow;
  const crumbs: Crumb[] = trail(folder, root, rootName).map((s, i, all) => (i === all.length - 1 ? { key: s.path, name: s.name, here: true } : { key: s.path, name: s.name, go: () => go({ kind: "folder", path: s.path }), drop: dropInto(s.path), over: over === s.path }));

  const body = (): ReactElement => {
    if (place.kind === "trash") return <TrashView key={trashTick} rootName={rootName} onChanged={() => folders.reload()} onDone={ops.say} onError={setErrorNote} onCount={setTrashCount} />;
    if (view === "gallery" && !found && place.kind === "folder") return <GalleryView entries={ordered} h={h} empty={empty} reading={reading} />;
    if (view === "columns" && !found && place.kind === "folder") {
      return (
        <ColumnsView
          columns={columns}
          preview={lead?.kind === "file" ? lead : null}
          rootName={rootName}
          h={h}
          actions={
            lead?.kind === "file" ? (
              <div className="finder-preview-acts">
                <button type="button" className="btn btn--sm" onClick={() => setLooking(true)}>
                  Quick Look
                </button>
                {onAsk && (
                  <button type="button" className="btn btn--sm" onClick={() => onAsk([lead.path])}>
                    Ask KOS
                  </button>
                )}
              </div>
            ) : undefined
          }
        />
      );
    }
    return (
      <ListView
        rows={listRows}
        layout={sidebar ? FILES_LAYOUT : PANEL_LAYOUT}
        sort={sort}
        onSort={setSort}
        h={h}
        empty={empty}
        reading={reading}
        {...(place.kind === "folder" && !found
          ? {
              onToggle: (entry: DirEntry) =>
                setExpanded((x) => {
                  const next = new Set(x);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                }),
            }
          : {})}
      />
    );
  };
  const notice = ops.notice ?? (errorNote ? { text: errorNote, tone: "err" as const } : null);

  return (
    <div ref={frame} className={`finder${sidebarShown ? " finder--sidebar" : ""}${narrow ? " finder--narrow" : ""}`}>
      <Toolbar
        title={
          sidebar && narrow ? (
            <Select
              className="finder-places"
              label="Go to"
              value={place.kind === "folder" ? `f:${folder}` : place.kind}
              options={[
                { value: "f:.", label: rootName },
                { value: "recents", label: "Recents" },
                ...projects.map((p) => ({ value: `f:projects/${p.slug}`, label: p.name, icon: <ProjectMark slug={p.slug} name={p.name} colour={p.colour} /> })),
                ...(place.kind === "folder" && folder !== "." && !projects.some((p) => `projects/${p.slug}` === folder) ? [{ value: `f:${folder}`, label: nameOf(folder) }] : []),
                { value: "trash", label: "Trash" },
              ]}
              onChange={(v) => go(v === "recents" ? { kind: "recents" } : v === "trash" ? { kind: "trash" } : { kind: "folder", path: v.slice(2) })}
            />
          ) : place.kind === "folder" && !found ? (
            <Crumbs items={crumbs} label="Where you are" className="finder-where-crumbs" title={pathWords(crumbs.map((c) => c.name))} />
          ) : (
            <span className="finder-title-words">{title}</span>
          )
        }
        {...(step(-1) ? { back: step(-1) } : {})}
        {...(step(1) ? { forward: step(1) } : {})}
        {...(place.kind === "folder" ? { view } : {})}
        sortMenu={place.kind === "folder" && !found && view !== "list"}
        views={narrow ? ["list", "gallery"] : ["list", "columns", "gallery"]}
        onView={pickView}
        sort={sort}
        onSort={setSort}
        searchable={place.kind !== "trash"}
        query={query}
        onQuery={setQuery}
        contents={contents}
        onContents={setContents}
        {...(making ? { onNewFolder: () => void startNewFolder(), onUpload: () => picker.current?.click() } : {})}
        uploading={ops.uploading}
        {...(place.kind !== "trash" ? { onInfo: () => setInfoPath(lead?.path ?? here) } : {})}
        {...(place.kind !== "trash"
          ? {
              onActions: (button: HTMLElement) => menuUnder(button, chosen.length ? itemsFor(chosen) : folderItems(), "Actions"),
              onMore: (button: HTMLElement) => menuUnder(button, moreItems(), "More"),
            }
          : {})}
      />
      <div className="finder-body">
        {sidebarShown && <Sidebar place={place} go={go} top={top} projects={projects} drop={dropInto} over={over} dropOnTrash={dropOnTrash} trashOver={over === "#trash"} />}
        <div
          ref={mainScroll}
          className={`finder-main${over === here && place.kind === "folder" ? " is-drop" : ""}`}
          tabIndex={0}
          role="group"
          aria-label={`${title}, ${status}`}
          // The keys stay here; the chosen row is what a reader hears as they move it.
          {...(activeRow ? { "aria-activedescendant": activeRow } : {})}
          onKeyDown={onKey}
          onMouseDown={(e) => {
            // A press on the ground clears the choice, as in Finder.
            if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("finder-list") || (e.target as HTMLElement).classList.contains("finder-gallery")) setSel(EMPTY_SELECTION);
          }}
          onContextMenu={(e: MouseEvent) => {
            if ((e.target as HTMLElement).closest("[data-path]")) return;
            // The menu key on the list, not a press on its ground: the menu for what is chosen.
            if (e.button !== 2) {
              e.preventDefault();
              keyMenu();
              return;
            }
            if (!making) return;
            e.preventDefault();
            setSel(EMPTY_SELECTION);
            setMenu({ at: { x: e.clientX, y: e.clientY }, items: folderItems(), label: "Folder actions" });
          }}
          {...(making ? dropInto(here) : {})}
        >
          {body()}
        </div>
      </div>
      {place.kind === "trash" ? (
        <div className="finder-pathbar">
          <Crumbs items={[{ key: "trash", name: "Trash", icon: <NavIcon name="trash" />, here: true }]} label="Path" className="finder-path" title="Trash" />
          <span className="finder-status">{`${trashCount} item${trashCount === 1 ? "" : "s"}`}</span>
        </div>
      ) : (
        <PathBar
          path={lead ? parentOf(lead.path) : here}
          {...(lead ? { leaf: lead } : {})}
          root={root}
          rootName={rootName}
          go={(dir) => go({ kind: "folder", path: dir })}
          drop={dropInto}
          over={over}
          status={status}
        />
      )}

      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="Upload files"
        onChange={(e) => {
          void ops.upload(Array.from(e.target.files ?? []), here);
          e.target.value = "";
        }}
      />
      {menu && (
        <FinderMenu
          at={menu.at}
          items={menu.items}
          label={menu.label}
          onClose={() => {
            setMenu(null);
            // The keys go back to the list, with the choice they had; an item that opens a sheet takes them from there.
            main.current?.focus({ preventScroll: true });
          }}
        />
      )}
      <NewFolderDialog
        suggested={naming}
        onClose={() => setNaming(null)}
        onMake={(name) => {
          setNaming(null);
          void ops.newFolder(here, name).then((made) => made && setSel(only(made)));
        }}
      />
      <MoveDialog
        paths={moving}
        projects={projects}
        folders={[".", ...topFolders, ...projects.map((p) => `projects/${p.slug}`), ...trail(folder, root, rootName).map((s) => s.path), ...(entriesOf(here) ?? []).filter((e) => e.kind === "dir").map((e) => e.path)].filter((f) => within(f, root))}
        onClose={() => setMoving(null)}
        onMove={(dir) => {
          const paths = moving ?? [];
          setMoving(null);
          void ops.move(paths, dir);
        }}
      />
      <Drawer open={infoPath !== null} title="Info" subtitle={infoPath ? (byPath.get(infoPath) ? kindOf(byPath.get(infoPath)!) : nameOf(infoPath) || rootName) : ""} onClose={() => setInfoPath(null)}
        footer={
          infoPath ? (
            <SheetFoot
              primary={
                <>
              {byPath.get(infoPath)?.kind === "file" && (
                <button type="button" className="btn btn--sm" onClick={() => {
                  setSel(only(infoPath));
                  setInfoPath(null);
                  setLooking(true);
                }}>
                  Quick Look
                </button>
              )}
              {byPath.get(infoPath)?.kind === "file" && (
                <button type="button" className="btn btn--sm" onClick={() => ops.download([infoPath])}>
                  Download
                </button>
              )}
              <button type="button" className="btn btn--sm" onClick={() => ops.copyPath([infoPath])}>
                Copy path
              </button>
              {onAsk && (
                <button type="button" className="btn btn--sm btn--primary" onClick={() => onAsk([infoPath])}>
                  Ask KOS about this
                </button>
              )}
                </>
              }
            />
          ) : undefined
        }
      >
        {infoPath && <FileFacts path={infoPath} rootName={rootName} />}
      </Drawer>
      <FilePreview
        path={lookPath}
        siblings={files}
        onStep={(p) => setSel(only(p))}
        onClose={() => setLooking(false)}
        paused={paused}
        quickLook
        {...(focus && focusLine !== undefined ? { line: { path: focus, line: focusLine } } : {})}
        actions={
          lookPath ? (
            <>
              <button type="button" className="btn btn--sm" onClick={() => ops.download([lookPath])}>
                Download
              </button>
              {onAsk && (
                <button type="button" className="btn btn--sm" onClick={() => onAsk([lookPath])}>
                  Ask KOS
                </button>
              )}
            </>
          ) : undefined
        }
      />
      <Toast
        note={
          notice && {
            kind: notice.tone,
            text: notice.text,
            ...("undo" in notice && notice.undo ? { undo: notice.undo } : {}),
            onDismiss: () => {
              ops.dismiss();
              setErrorNote(null);
            },
          }
        }
      />
    </div>
  );
}
