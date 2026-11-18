import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { isZip, readZip } from "../files/zip.js";
import type { Workspace } from "../store/workspace.js";

/**
 * A small picture of a document, for the file manager's icons and gallery.
 *
 * Pictures are drawn by the dashboard from their own bytes and are not
 * here. A Pages, Keynote or Numbers file keeps a preview of its first page,
 * read out of it anywhere. On a Mac, QuickLook draws the rest: a PDF's
 * first page, a Word, Excel or PowerPoint file, a video's frame. Each is
 * kept under .kos/cache/thumbs by the file's path, time and size, so it is
 * drawn once per version. Nothing comes back for a file no host can draw;
 * the dashboard shows its kind's mark.
 */

const CACHE = ".kos/cache/thumbs";
/** Kept thumbnails past this are cleared, oldest first, down to half. */
const CACHE_FILES_MAX = 4000;
/** Past this a file is not handed to QuickLook for a thumbnail. */
const THUMB_INPUT_MAX = 60 * 1024 * 1024;
export const THUMB_EDGES = [128, 256, 512] as const;

const IWORK = new Set([".pages", ".key", ".numbers"]);
/** What QuickLook is asked to draw: documents and videos, never markup that would run in its renderer. */
const QUICKLOOK = new Set([
  ".pdf", ".docx", ".doc", ".rtf", ".odt", ".xlsx", ".xls", ".ods", ".pptx", ".ppt", ".odp", ".pages", ".key", ".numbers",
  ".mov", ".mp4", ".m4v", ".heic", ".heif", ".tiff", ".tif", ".psd",
]);

export interface Thumb {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
}

export type QuickLook = (bytes: Uint8Array, ext: string, edge: number) => Promise<Buffer | undefined>;

/** Whether a thumbnail is worth asking for at all: the dashboard skips the request for anything else. */
export function thumbable(name: string, quickLook: boolean): boolean {
  const ext = extname(name).toLowerCase();
  return IWORK.has(ext) || (quickLook && QUICKLOOK.has(ext));
}

export async function thumbnail(ws: Workspace, rel: string, edge: number, quickLook?: QuickLook): Promise<Thumb | undefined> {
  const abs = ws.resolve(rel);
  const st = statSync(abs);
  if (!st.isFile() || st.size > THUMB_INPUT_MAX) return undefined;
  const ext = extname(rel).toLowerCase();
  if (!thumbable(rel, !!quickLook)) return undefined;
  const key = createHash("sha256").update(`${rel}\0${st.mtimeMs}\0${st.size}\0${edge}`).digest("hex").slice(0, 32);
  const dir = ws.resolve(CACHE);
  const cached = join(dir, `${key}.img`);
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    return { bytes, contentType: bytes[0] === 0xff ? "image/jpeg" : "image/png" };
  }
  const bytes = readFileSync(abs);
  let made: Thumb | undefined;
  if (IWORK.has(ext) && isZip(bytes)) {
    const preview = readZip(bytes, { only: (n) => n === "preview.jpg" || n === "preview-web.jpg" || n === "QuickLook/Thumbnail.jpg", entryMax: 8 * 1024 * 1024 });
    const jpeg = preview.get("preview-web.jpg") ?? preview.get("preview.jpg") ?? preview.get("QuickLook/Thumbnail.jpg");
    if (jpeg) made = { bytes: jpeg, contentType: "image/jpeg" };
  }
  if (!made && quickLook) {
    const png = await quickLook(bytes, ext.slice(1), edge);
    if (png) made = { bytes: png, contentType: "image/png" };
  }
  if (made) keep(dir, cached, made.bytes);
  return made;
}

function keep(dir: string, file: string, bytes: Buffer): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, bytes);
  const names = readdirSync(dir);
  if (names.length <= CACHE_FILES_MAX) return;
  const aged = names.map((n) => ({ n, at: statSync(join(dir, n)).mtimeMs })).sort((a, b) => a.at - b.at);
  for (const { n } of aged.slice(0, names.length - CACHE_FILES_MAX / 2)) rmSync(join(dir, n), { force: true });
}
