import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative as pathRelative, sep } from "node:path";

import { isOffice, officeNote, officeText } from "../files/office.js";
import { isPdf, pdfText } from "../files/pdftext.js";
import { foldedPath, type Workspace } from "../store/workspace.js";

/**
 * Browsing the workspace for the dashboard.
 *
 * Every path resolves through the jail, so a request cannot walk out of the
 * workspace even though these routes take a path from the client. The agent
 * edits files through its own guarded tools; what is here for writing is the
 * owner's own hand on their files (below), which the agent never reaches.
 */

export interface DirEntry {
  name: string;
  /** Workspace-relative path, always forward-slashed. */
  path: string;
  kind: "dir" | "file";
  size: number;
  modifiedAt: number;
  /** One of the workspace's own (RESERVED): listed, but never renamed, moved or trashed. */
  reserved?: true;
}

export interface FileContent {
  path: string;
  size: number;
  modifiedAt: number;
  /** Absent when the file is binary or past the read cap. */
  text?: string;
  /** Why the text is absent, when it is. */
  omitted?: "binary" | "too-large";
  language: string;
  /** Set when `text` is what was read out of a document rather than the file's own bytes: "docx, 12 paragraphs". */
  extracted?: string;
}

/** Past this a document is not read for the page; it can still be downloaded. */
const MAX_DOCUMENT_BYTES = 20_000_000;

const MAX_TEXT_BYTES = 512_000;

/**
 * Image types the dashboard will render inline, and the type each is served
 * as. The dashboard holds full agent authority on its own origin, so a
 * workspace file served as something the browser will execute is a way in for
 * anything that ever gets written into the workspace, including files the
 * agent downloaded. Hence an allow-list of types the browser only ever
 * decodes, rather than a deny-list of the ones it runs.
 *
 * SVG is not on it and should not be added. It looks like an image and is
 * really a document: it carries script and runs it on the origin that served
 * it. It is displayed here as text, like any other markup.
 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** Past this an image is linked rather than previewed. */
const MAX_IMAGE_BYTES = 8_000_000;

export interface RawFile {
  bytes: Buffer;
  contentType: string;
}

/** Whether the browser can be shown this file as a picture. */
export function isImage(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_TYPES;
}

/** Extensions we will show as text; anything else is treated as binary. */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml",
  ".toml", ".ini", ".env", ".log", ".sql", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".css", ".html", ".xml", ".svg", ".sh", ".py", ".rb", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".conf", ".gitignore",
]);

const LANGUAGE: Record<string, string> = {
  ".md": "markdown", ".markdown": "markdown", ".json": "json", ".jsonl": "json",
  ".sql": "sql", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
  ".css": "css", ".html": "html", ".xml": "xml", ".svg": "xml",
  ".sh": "bash", ".py": "python", ".yaml": "yaml", ".yml": "yaml",
  ".csv": "csv", ".toml": "toml",
};

/** Normalise a client path to something the jail will accept. */
function relative(input: unknown): string {
  if (typeof input !== "string" || input === "" || input === "/") return ".";
  return input.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function listDirectory(ws: Workspace, requestPath: unknown): DirEntry[] {
  const rel = relative(requestPath);
  const abs = ws.resolve(rel);
  const base = rel === "." ? "" : `${rel.replace(/\/+$/, "")}/`;

  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e): DirEntry => {
      const child = join(abs, e.name);
      let size = 0;
      let modifiedAt = 0;
      try {
        const st = statSync(child);
        size = st.isFile() ? st.size : 0;
        modifiedAt = st.mtimeMs;
      } catch {
        // A file that vanished between readdir and stat is simply not listed
        // with a size; it is not an error worth failing the whole listing for.
      }
      return {
        name: e.name,
        path: `${base}${e.name}`,
        kind: e.isDirectory() ? "dir" : "file",
        size,
        modifiedAt,
        ...(base === "" && isReservedName(e.name) ? { reserved: true as const } : {}),
      };
    });

  // Directories first, then by name: the ordering people expect from a browser.
  return entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name)
      : a.kind === "dir"
        ? -1
        : 1,
  );
}

export function readFile(ws: Workspace, requestPath: unknown): FileContent {
  const rel = relative(requestPath);
  const abs = ws.resolve(rel);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`not a file: ${rel}`);

  const ext = extname(rel).toLowerCase();
  const base = {
    path: rel,
    size: st.size,
    modifiedAt: st.mtimeMs,
    language: LANGUAGE[ext] ?? "",
  };

  if (!TEXT_EXTENSIONS.has(ext)) return { ...base, omitted: "binary" };
  if (st.size > MAX_TEXT_BYTES) return { ...base, omitted: "too-large" };
  return { ...base, text: readFileSync(abs, "utf8") };
}

/**
 * A file for the page: as readFile has it, except that a Word, Excel or
 * PowerPoint file comes back as the text read out of it, marked as such. A
 * PDF stays binary here: the page shows it in the browser's own viewer,
 * which is the PDF itself rather than its words.
 */
export function readForView(ws: Workspace, requestPath: unknown): FileContent {
  const file = readFile(ws, requestPath);
  if (file.omitted !== "binary" || file.size > MAX_DOCUMENT_BYTES) return file;
  const bytes = readFileSync(ws.resolve(file.path));
  if (!isOffice(bytes, file.path)) return file;
  const { omitted: _omitted, ...rest } = file;
  const read = officeText(new Uint8Array(bytes), file.path);
  return { ...rest, text: read.text, extracted: officeNote(read) };
}

/** A file as words, for a reader who wants them rather than the file. */
export interface FileText {
  path: string;
  text: string;
  /** What was read, when read out of a document: "pdf, 3 pages". */
  extracted?: string;
}

/**
 * A file as words: a text file as it is; a PDF or an Office file read the
 * way an attachment is read for the model, so the owner sees what KOS
 * sees. Nothing for an image or any other binary.
 */
export async function readForText(ws: Workspace, requestPath: unknown): Promise<FileText> {
  const file = readFile(ws, requestPath);
  if (file.text !== undefined) return { path: file.path, text: file.text };
  if (file.omitted === "too-large" || file.size > MAX_DOCUMENT_BYTES) throw new Error(`too large to read: ${file.path}`);
  const bytes = readFileSync(ws.resolve(file.path));
  if (isPdf(bytes)) {
    const read = await pdfText(new Uint8Array(bytes));
    return { path: file.path, text: read.text, extracted: `pdf, ${read.pages} page${read.pages === 1 ? "" : "s"}${read.truncated ? ", cut at the cap" : ""}` };
  }
  if (isOffice(bytes, file.path)) {
    const read = officeText(new Uint8Array(bytes), file.path);
    return { path: file.path, text: read.text, extracted: officeNote(read) };
  }
  throw new Error(`nothing to read out of ${file.path}`);
}

/** A PDF's bytes for the browser's own viewer; nothing else is served inline. Its first bytes say so before the rest is read. */
export function readPdf(ws: Workspace, requestPath: unknown): RawFile & { name: string } {
  const rel = relative(requestPath);
  const head = new Uint8Array(8);
  const fd = openSync(ws.resolve(rel), "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (!isPdf(head)) throw new Error(`not a PDF: ${basename(rel)}`);
  return { ...readBytes(ws, rel), contentType: "application/pdf" };
}

/**
 * The bytes of an image, for previewing in the dashboard.
 *
 * Only the allow-listed types, and only up to a size worth sending down a
 * socket to draw a thumbnail. Everything else is refused here rather than
 * handed to the browser to work out what it is.
 */
export function readImage(ws: Workspace, requestPath: unknown): RawFile {
  const rel = relative(requestPath);
  const contentType = IMAGE_TYPES[extname(rel).toLowerCase()];
  if (!contentType) throw new Error(`not a previewable image: ${rel}`);

  const abs = ws.resolve(rel);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`not a file: ${rel}`);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`too large to preview: ${rel}`);

  return { bytes: readFileSync(abs), contentType };
}

/*
 * Owner's file management, from the dashboard.
 *
 * Browsing stayed read-only for a long time because the agent has its own
 * guarded write path and a second one was a second thing to get right. The
 * owner is not the agent: these are their files, moved and renamed by hand,
 * so there is no approval and no sandbox, only the jail and a short list of
 * things the workspace cannot do without.
 */

/** Top-level names the file manager leaves alone: the workspace's own state. Compare with isReserved, never by hand. */
export const RESERVED = new Set([".kos", "kos.sqlite", "kos.sqlite-shm", "kos.sqlite-wal", "profile.json", "mcp.json", "daemon.json", "locks"]);

/**
 * A name folded as APFS compares names: compatibility-normalized (NFKC, so
 * "\ufb01" is "fi"), then case-folded the long way round (upper, then lower,
 * so "\u017f" is "s"). On a case-insensitive disk "Kos.\u017fqlite-wal" opens
 * kos.sqlite-wal; folded, it is refused as that.
 */
export function foldName(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase();
}

/** A name is one of the workspace's own (RESERVED), however it is spelled. */
export function isReservedName(name: string): boolean {
  return RESERVED.has(foldName(name));
}

/**
 * A workspace-relative path lies in the workspace's own files: its first
 * segment folded as the disk folds it, and also as the path lands on disk
 * (foldedPath reads the real names), so neither a spelling nor a link to one
 * gets past. The one test for RESERVED; #557 and #561 use it too.
 */
export function isReserved(root: string, rel: string): boolean {
  return isReservedName(firstSegment(rel)) || isReservedName(firstSegment(foldedPath(root, rel)));
}

/** A workspace-relative path's first name, past any "." or empty segment, either slash. */
export function firstSegment(path: string): string {
  return path.replace(/\\/g, "/").split("/").find((s) => s !== "" && s !== ".") ?? "";
}

/** A path the manager may touch: inside the jail, not the root, not the workspace's own files. */
export function managedPath(ws: Workspace, requestPath: unknown): { rel: string; abs: string } {
  // Through the jail first, then named as the jail resolved it: "./kos.sqlite",
  // "projects//x" and "a/./b" are tested as what they are, not as typed.
  const abs = ws.resolve(relative(requestPath));
  const rel = pathRelative(ws.root, abs).split(sep).join("/");
  if (rel === "") throw new Error("the workspace itself cannot be moved or removed");
  if (isReserved(ws.root, rel)) throw new Error(`KOS keeps its own records in ${rel.split("/")[0]}; it can't be moved or deleted`);
  return { rel, abs };
}

/** Something at the top level is part of the workspace's layout, not a thing to move. */
export function refuseLayout(rel: string): void {
  if (!rel.includes("/")) throw new Error(`${rel} is part of the workspace's layout; manage what is inside it`);
}

/** Move or rename, never over something that exists. */
export function renameEntry(ws: Workspace, from: unknown, to: unknown): { path: string } {
  const src = managedPath(ws, from);
  const dst = managedPath(ws, to);
  refuseLayout(src.rel);
  if (!existsSync(src.abs)) throw new Error(`no such file: ${src.rel}`);
  if (existsSync(dst.abs)) throw new Error(`${dst.rel} already exists`);
  if (dst.rel === src.rel || dst.rel.startsWith(`${src.rel}/`)) throw new Error("a folder cannot be moved into itself");
  mkdirSync(dirname(dst.abs), { recursive: true });
  renameSync(src.abs, dst.abs);
  return { path: dst.rel };
}

/** "name copy.ext", then "name copy 2.ext": a sibling name nothing has yet. */
export function uniqueName(ws: Workspace, dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const dirAbs = ws.resolve(relative(dir));
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
    if (!existsSync(join(dirAbs, candidate))) return candidate;
  }
  throw new Error("too many copies");
}

/** Copy a file or a folder; without a destination, a sibling called "… copy". */
export function copyEntry(ws: Workspace, from: unknown, to?: unknown): { path: string } {
  const src = managedPath(ws, from);
  if (!existsSync(src.abs)) throw new Error(`no such file: ${src.rel}`);
  const parent = dirname(src.rel) === "." ? "" : dirname(src.rel);
  const target = typeof to === "string" && to ? to : `${parent ? `${parent}/` : ""}${uniqueName(ws, parent || ".", basename(src.rel))}`;
  const dst = managedPath(ws, target);
  if (existsSync(dst.abs)) throw new Error(`${dst.rel} already exists`);
  if (dst.rel.startsWith(`${src.rel}/`)) throw new Error("a folder cannot be copied into itself");
  mkdirSync(dirname(dst.abs), { recursive: true });
  cpSync(src.abs, dst.abs, { recursive: true });
  return { path: dst.rel };
}

export function makeDir(ws: Workspace, requestPath: unknown): { path: string } {
  const { rel, abs } = managedPath(ws, requestPath);
  if (existsSync(abs)) throw new Error(`${rel} already exists`);
  mkdirSync(abs, { recursive: true });
  return { path: rel };
}

/** Past this a file is too big to hand to the browser in one go. */
const MAX_DOWNLOAD_BYTES = 200_000_000;

/** A file's bytes for saving, whatever it is; images keep their type. */
export function readBytes(ws: Workspace, requestPath: unknown): RawFile & { name: string } {
  const rel = relative(requestPath);
  const abs = ws.resolve(rel);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`not a file: ${rel}`);
  if (st.size > MAX_DOWNLOAD_BYTES) throw new Error(`too large to download here: ${rel}`);
  return { bytes: readFileSync(abs), contentType: IMAGE_TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream", name: basename(rel) };
}

/**
 * A Content-Disposition that names the file, so a viewer's Save or Download
 * offers its name and not the route's: plain ASCII for old readers, and the
 * whole name encoded (RFC 6266 and 5987) for the rest.
 */
export function dispositionOf(kind: "inline" | "attachment", name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const full = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${plain}"; filename*=UTF-8''${full}`;
}
