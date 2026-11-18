import type { DirEntry } from "../api.js";

/**
 * The file manager's rules, apart from drawing them: how a folder sorts,
 * what a kind is called, how sizes and dates are said, and how selection
 * moves under the pointer and the keys, the way Finder does it.
 */

export type FinderView = "list" | "columns" | "gallery";
export type SortKey = "name" | "modified" | "size" | "kind";
export interface Sort {
  key: SortKey;
  desc: boolean;
}

const EXT_KIND: Record<string, string> = {
  docx: "Word document", docm: "Word document", doc: "Word document", dotx: "Word template", rtf: "Rich text document", odt: "OpenDocument text", pages: "Pages document",
  xlsx: "Excel workbook", xlsm: "Excel workbook", xlsb: "Excel workbook", xls: "Excel workbook", ods: "OpenDocument spreadsheet", numbers: "Numbers spreadsheet", csv: "CSV table", tsv: "TSV table",
  pptx: "PowerPoint deck", pptm: "PowerPoint deck", ppsx: "PowerPoint show", ppt: "PowerPoint deck", odp: "OpenDocument deck", key: "Keynote deck",
  pdf: "PDF document", md: "Markdown", markdown: "Markdown", txt: "Plain text", log: "Log",
  json: "JSON", jsonl: "JSON lines", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", html: "HTML", css: "CSS", sql: "SQL",
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", py: "Python", sh: "Shell script", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", c: "C", cpp: "C++", h: "C header", swift: "Swift",
  png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image", webp: "WebP image", avif: "AVIF image", heic: "HEIC image", svg: "SVG image", bmp: "BMP image", ico: "Icon", tiff: "TIFF image",
  mp3: "MP3 audio", m4a: "AAC audio", wav: "WAV audio", flac: "FLAC audio", ogg: "Ogg audio", mp4: "MPEG-4 video", m4v: "MPEG-4 video", mov: "QuickTime movie", webm: "WebM video",
  zip: "ZIP archive", tar: "Tar archive", gz: "Gzip archive", tgz: "Gzip archive", db: "Database", sqlite: "SQLite database",
};

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What a thing is called in the Kind column. */
export function kindOf(entry: Pick<DirEntry, "name" | "kind">): string {
  if (entry.kind === "dir") return "Folder";
  const ext = extOf(entry.name);
  return EXT_KIND[ext] ?? (ext ? `${ext.toUpperCase()} file` : "Document");
}

/** Folders first, then by the key; names compare as people read them ("2" before "10"). */
export function sortEntries<T extends DirEntry>(entries: T[], sort: Sort): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const by = (a: T, b: T): number => {
    switch (sort.key) {
      case "modified":
        return a.modifiedAt - b.modifiedAt || byName(a, b);
      case "size":
        return a.size - b.size || byName(a, b);
      case "kind":
        return kindOf(a).localeCompare(kindOf(b)) || byName(a, b);
      default:
        return byName(a, b);
    }
  };
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    const order = by(a, b);
    return sort.desc ? -order : order;
  });
}

/** A size as Finder says one: in thousands, the way a disk is sold. */
export function sizeWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  return `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} ${units[unit]}`;
}

/** A date as Finder says one: "Today at 3:42 PM", "Yesterday at 9:01 AM", else the date. */
export function dateWords(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(at.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
  return `${date} at ${time}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

export function nameOf(path: string): string {
  return path === "." ? "" : (path.split("/").pop() ?? path);
}

export function joinPath(dir: string, name: string): string {
  return dir === "." || dir === "" ? name : `${dir}/${name}`;
}

/** Whether `path` is `dir` or inside it. */
export function within(path: string, dir: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}

/** The folders from `root` down to `path`, each with its name; the root is named `rootName`. */
export function trail(path: string, root: string, rootName: string): { path: string; name: string }[] {
  const out = [{ path: root, name: rootName }];
  if (!within(path, root) || path === root) return out;
  const rest = root === "." ? path : path.slice(root.length + 1);
  let at = root;
  for (const part of rest.split("/")) {
    at = joinPath(at, part);
    out.push({ path: at, name: part });
  }
  return out;
}

/** A reference to a file as the composer writes one, bracketed when the path has a space or other characters a plain one cannot hold. */
export function fileMention(path: string): string {
  return /^[A-Za-z0-9._/-]*[A-Za-z0-9_/-]$/.test(path) ? `@file:${path}` : `@file:[${path}]`;
}

/** A name for a new thing in a folder that nothing has yet: "untitled folder", then "untitled folder 2". */
export function freeName(taken: Iterable<string>, base: string): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/* Selection: a set of paths, the anchor a Shift range runs from, and the lead the keys move. */

export interface Selection {
  paths: string[];
  anchor: string | null;
  lead: string | null;
}

export const EMPTY_SELECTION: Selection = { paths: [], anchor: null, lead: null };

export function only(path: string): Selection {
  return { paths: [path], anchor: path, lead: path };
}

/** A click: alone it selects one; Cmd adds or removes one; Shift selects the run from the anchor. */
export function clickSelect(sel: Selection, path: string, order: string[], mods: { shift?: boolean; meta?: boolean }): Selection {
  if (mods.shift && sel.anchor && order.includes(sel.anchor)) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(path);
    const run = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const kept = mods.meta ? sel.paths.filter((p) => !run.includes(p)) : [];
    return { paths: [...kept, ...run], anchor: sel.anchor, lead: path };
  }
  if (mods.meta) {
    const has = sel.paths.includes(path);
    const paths = has ? sel.paths.filter((p) => p !== path) : [...sel.paths, path];
    return { paths, anchor: path, lead: has ? (paths[paths.length - 1] ?? null) : path };
  }
  return only(path);
}

/** The arrow keys: the lead moves by `delta` (a row, or a row of tiles); with Shift the selection grows from the anchor. */
export function moveLead(sel: Selection, order: string[], delta: number, extend: boolean): Selection {
  if (!order.length) return sel;
  const at = sel.lead ? order.indexOf(sel.lead) : -1;
  const next = order[at < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + delta))]!;
  if (!extend || !sel.anchor) return only(next);
  return clickSelect(sel, next, order, { shift: true });
}

/** Typing a name's first letters picks the first entry, in order, whose name starts so; nothing when none does. */
export function typeSelect(entries: Pick<DirEntry, "name" | "path">[], typed: string): string | undefined {
  const q = typed.toLowerCase();
  return entries.find((e) => e.name.toLowerCase().startsWith(q))?.path;
}

/* Remembered per folder: how it is looked at. */

const VIEWS_KEY = "kos.finder.views";
const VIEWS_KEPT = 400;

function readViews(): Record<string, FinderView> {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, FinderView>) : {};
  } catch {
    return {};
  }
}

export function viewFor(path: string, fallback: FinderView): FinderView {
  const v = readViews()[path];
  return v === "list" || v === "columns" || v === "gallery" ? v : fallback;
}

export function rememberView(path: string, view: FinderView): void {
  try {
    const views = readViews();
    delete views[path];
    views[path] = view;
    const keys = Object.keys(views);
    for (const old of keys.slice(0, Math.max(0, keys.length - VIEWS_KEPT))) delete views[old];
    localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch {
    // Not remembering is no reason to refuse the view.
  }
}
