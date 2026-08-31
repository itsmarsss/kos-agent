import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

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
