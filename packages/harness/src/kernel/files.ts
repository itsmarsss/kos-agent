import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import type { Workspace } from "../store/workspace.js";

/**
 * Read-only browsing of the workspace for the dashboard.
 *
 * Every path resolves through the jail, so a request cannot walk out of the
 * workspace even though these routes take a path from the client. Browsing is
 * read-only on purpose: the agent edits files through its own guarded tools,
 * and a second write path here would be a second thing to get right.
 */

export interface DirEntry {
  name: string;
  /** Workspace-relative path, always forward-slashed. */
  path: string;
  kind: "dir" | "file";
  size: number;
  modifiedAt: number;
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
}

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

/** Top-level names the file manager leaves alone: the workspace's own state. */
const RESERVED = new Set([".kos", "kos.sqlite", "kos.sqlite-shm", "kos.sqlite-wal", "profile.json", "mcp.json", "daemon.json", "locks"]);

/** A path the manager may touch: inside the jail, not the root, not the workspace's own files. */
function managed(ws: Workspace, requestPath: unknown): { rel: string; abs: string } {
  const rel = relative(requestPath).replace(/\/+$/, "");
  if (rel === "." || rel === "") throw new Error("the workspace itself cannot be moved or removed");
  const top = rel.split("/")[0]!;
  if (RESERVED.has(top)) throw new Error(`${top} is the workspace's own; leave it be`);
  return { rel, abs: ws.resolve(rel) };
}

/** Something at the top level is part of the workspace's layout, not a thing to move. */
function layout(rel: string): void {
  if (!rel.includes("/")) throw new Error(`${rel} is part of the workspace's layout; manage what is inside it`);
}

/** Move or rename, never over something that exists. */
export function renameEntry(ws: Workspace, from: unknown, to: unknown): { path: string } {
  const src = managed(ws, from);
  const dst = managed(ws, to);
  layout(src.rel);
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
  const src = managed(ws, from);
  if (!existsSync(src.abs)) throw new Error(`no such file: ${src.rel}`);
  const parent = dirname(src.rel) === "." ? "" : dirname(src.rel);
  const target = typeof to === "string" && to ? to : `${parent ? `${parent}/` : ""}${uniqueName(ws, parent || ".", basename(src.rel))}`;
  const dst = managed(ws, target);
  if (existsSync(dst.abs)) throw new Error(`${dst.rel} already exists`);
  if (dst.rel.startsWith(`${src.rel}/`)) throw new Error("a folder cannot be copied into itself");
  mkdirSync(dirname(dst.abs), { recursive: true });
  cpSync(src.abs, dst.abs, { recursive: true });
  return { path: dst.rel };
}

/** Remove a file, or a folder and everything in it. */
export function deleteEntry(ws: Workspace, requestPath: unknown): { path: string } {
  const { rel, abs } = managed(ws, requestPath);
  layout(rel);
  if (!existsSync(abs)) throw new Error(`no such file: ${rel}`);
  rmSync(abs, { recursive: true, force: true });
  return { path: rel };
}

export function makeDir(ws: Workspace, requestPath: unknown): { path: string } {
  const { rel, abs } = managed(ws, requestPath);
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
