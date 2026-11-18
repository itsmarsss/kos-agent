import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { imageTypeOf, pictureSize } from "../files/headers.js";
import { isPdf, pdfPages } from "../files/pdftext.js";
import { isZip, readZip } from "../files/zip.js";
import type { Workspace } from "../store/workspace.js";
import { scan } from "../tools/scan.js";
import { RESERVED, type DirEntry } from "./files.js";

/**
 * What the file manager asks of the workspace beyond a folder's listing:
 * a search by name or by what is inside, the files changed lately, and one
 * file's facts. Every walk starts from a jailed path, never follows a link,
 * skips what is hidden and the workspace's own files (its database, its
 * settings), and stops at a bound, saying so.
 */

/** Entries looked at per walk: a workspace is thousands, not millions. */
const WALK_MAX = 30_000;
const NAMES_MAX = 300;
const RECENT_MAX = 60;
/** Folders never walked: tool caches, not the owner's things. */
const SKIP = new Set(["node_modules", "__pycache__", "site-packages", "venv", ".venv", "dist", "build", "target", "coverage"]);
/** A picture's or a document's head, read for its size and pages. */
const HEAD_BYTES = 256 * 1024;
const DOC_INFO_MAX = 30 * 1024 * 1024;

function relOf(input: unknown): string {
  if (typeof input !== "string" || input === "" || input === "/" || input === ".") return ".";
  return input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Every file and folder under `rel`, depth first, until `visit` says stop or the bound is reached. Returns whether it stopped early. */
function walk(ws: Workspace, rel: string, visit: (e: DirEntry) => boolean): boolean {
  let seen = 0;
  const stack = [rel];
  while (stack.length) {
    const dir = stack.pop()!;
    let names;
    try {
      names = readdirSync(ws.resolve(dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (d.name.startsWith(".") || (!d.isFile() && !d.isDirectory()) || (dir === "." && RESERVED.has(d.name.toLowerCase()))) continue;
      if (++seen > WALK_MAX) return true;
      const path = dir === "." ? d.name : `${dir}/${d.name}`;
      let st;
      try {
        st = statSync(join(ws.root, path));
      } catch {
        continue;
      }
      const entry: DirEntry = { name: d.name, path, kind: d.isDirectory() ? "dir" : "file", size: d.isFile() ? st.size : 0, modifiedAt: st.mtimeMs };
      if (!visit(entry)) return true;
      if (d.isDirectory() && !SKIP.has(d.name)) stack.push(path);
    }
  }
  return false;
}

export interface NameSearch {
  entries: DirEntry[];
  /** True when the walk or the results stopped at their bound. */
  truncated: boolean;
}

/** Files and folders under `dir` whose names hold `query`, any case. */
export function searchNames(ws: Workspace, dir: unknown, query: string): NameSearch {
  const rel = relOf(dir);
  ws.resolve(rel);
  const q = query.trim().toLowerCase();
  if (!q) return { entries: [], truncated: false };
  const entries: DirEntry[] = [];
  const truncated = walk(ws, rel, (e) => {
    if (e.name.toLowerCase().includes(q)) entries.push(e);
    return entries.length < NAMES_MAX;
  });
  return { entries, truncated };
}

export interface ContentHit extends DirEntry {
  /** The first line that matched, and its number. */
  line: number;
  text: string;
}

/** A literal pattern any case, for a search with no flags: each letter as both of its cases. */
function anyCase(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\p{L}/gu, (ch) => (ch.toLowerCase() === ch.toUpperCase() ? ch : `[${ch.toLowerCase()}${ch.toUpperCase()}]`));
}

/** Text files under `dir` holding `query`, any case: the workspace search the agent uses (search.grep's own reader). */
export function searchContents(ws: Workspace, dir: unknown, query: string): { entries: ContentHit[]; truncated: boolean } {
  const rel = relOf(dir);
  const abs = ws.resolve(rel);
  const q = query.trim();
  if (!q) return { entries: [], truncated: false };
  const result = scan(ws.root, abs, anyCase(q), { maxMatches: 400 });
  const byPath = new Map<string, ContentHit>();
  for (const line of result.lines) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m || byPath.has(m[1]!)) continue;
    const path = m[1]!.split("\\").join("/");
    try {
      const st = statSync(join(ws.root, path));
      byPath.set(m[1]!, { name: basename(path), path, kind: "file", size: st.size, modifiedAt: st.mtimeMs, line: Number(m[2]), text: m[3]!.trim().slice(0, 200) });
    } catch {
      // Gone since the search read it.
    }
  }
  return { entries: [...byPath.values()], truncated: result.truncated };
}

/** The files changed most lately, anywhere in the workspace. */
export function recentFiles(ws: Workspace, limit = RECENT_MAX): DirEntry[] {
  const files: DirEntry[] = [];
  walk(ws, ".", (e) => {
    if (e.kind === "file") files.push(e);
    return true;
  });
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit);
}

export interface FileInfo extends DirEntry {
  createdAt: number;
  /** A folder's items, hidden ones left out. */
  items?: number;
  /** A picture's size in pixels. */
  width?: number;
  height?: number;
  /** A PDF's pages, a deck's slides, a workbook's sheets, a Word file's pages as it last saved them. */
  pages?: number;
  pagesUnit?: "pages" | "slides" | "sheets";
}

function head(abs: string, bytes: number): Buffer {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** One file's or folder's facts, for the Info panel. */
export async function fileInfo(ws: Workspace, requestPath: unknown): Promise<FileInfo> {
  const rel = relOf(requestPath);
  const abs = ws.resolve(rel);
  const st = statSync(abs);
  const base: FileInfo = { name: rel === "." ? "workspace" : basename(rel), path: rel, kind: st.isDirectory() ? "dir" : "file", size: st.isFile() ? st.size : 0, modifiedAt: st.mtimeMs, createdAt: st.birthtimeMs || st.ctimeMs };
  if (st.isDirectory()) return { ...base, items: readdirSync(abs).filter((n) => !n.startsWith(".")).length };
  if (!st.isFile() || st.size === 0) return base;
  const top = head(abs, Math.min(st.size, HEAD_BYTES));
  const picture = imageTypeOf(top);
  if (picture) {
    const size = pictureSize(top, picture);
    return size ? { ...base, width: size.width, height: size.height } : base;
  }
  if (st.size > DOC_INFO_MAX) return base;
  if (isPdf(top)) {
    try {
      return { ...base, pages: await pdfPages(new Uint8Array(head(abs, st.size))), pagesUnit: "pages" };
    } catch {
      return base;
    }
  }
  if (isZip(top)) return { ...base, ...officeCounts(head(abs, st.size)) };
  return base;
}

/** What an Office file says of itself in docProps/app.xml: its pages, slides or sheets. */
function officeCounts(bytes: Buffer): Pick<FileInfo, "pages" | "pagesUnit"> {
  try {
    const app = readZip(bytes, { only: (n) => n === "docProps/app.xml", entryMax: 1024 * 1024 }).get("docProps/app.xml")?.toString("utf8") ?? "";
    const count = (tag: string): number | undefined => {
      const m = new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(app);
      return m ? Number(m[1]) : undefined;
    };
    const slides = count("Slides");
    if (slides !== undefined) return { pages: slides, pagesUnit: "slides" };
    const pages = count("Pages");
    if (pages !== undefined) return { pages, pagesUnit: "pages" };
    const sheets = /<vt:lpstr>Worksheets<\/vt:lpstr>\s*<\/vt:variant>\s*<vt:variant>\s*<vt:i4>(\d+)<\/vt:i4>/.exec(app);
    return sheets ? { pages: Number(sheets[1]), pagesUnit: "sheets" } : {};
  } catch {
    return {};
  }
}

/** Sound and video the dashboard plays, by extension: types a browser only ever decodes. */
const MEDIA_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};
/** The most one answer carries: a player asks for the rest by range. */
const MEDIA_CHUNK = 16 * 1024 * 1024;

/** A piece of a sound or video file, as a player asks for it by range; the start of it when it asks for none. */
export function readMedia(ws: Workspace, requestPath: unknown, range?: string): { bytes: Buffer; contentType: string; partial?: string } {
  const rel = relOf(requestPath);
  const contentType = MEDIA_TYPES[extname(rel).toLowerCase()];
  if (!contentType) throw new Error(`not a sound or video file: ${rel}`);
  const abs = ws.resolve(rel);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`not a file: ${rel}`);
  const asked = /^bytes=(\d*)-(\d*)$/.exec(range?.trim() ?? "");
  if (!asked && st.size <= MEDIA_CHUNK) return { bytes: head(abs, st.size), contentType };
  let start = asked?.[1] ? Number(asked[1]) : 0;
  let end = asked?.[2] ? Number(asked[2]) : st.size - 1;
  // "bytes=-500" is the last 500 bytes.
  if (asked && !asked[1] && asked[2]) {
    start = Math.max(0, st.size - Number(asked[2]));
    end = st.size - 1;
  }
  end = Math.min(end, st.size - 1, start + MEDIA_CHUNK - 1);
  if (start > end) throw new Error("that range is past the end of the file");
  const fd = openSync(abs, "r");
  try {
    const bytes = Buffer.alloc(end - start + 1);
    readSync(fd, bytes, 0, bytes.length, start);
    return { bytes, contentType, partial: `bytes ${start}-${end}/${st.size}` };
  } finally {
    closeSync(fd);
  }
}
