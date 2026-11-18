import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { converterHere, IMAGE_MAX_PIXELS, imageTypeOf, type Converter } from "../files/images.js";
import { limited } from "../files/viewer/run.js";
import { isZip, readZip } from "../files/zip.js";
import type { Workspace } from "../store/workspace.js";

/**
 * A small picture of a file, for the file manager's icons and gallery.
 *
 * Pictures a browser draws come from their own bytes and are not here. A
 * Pages, Keynote or Numbers file keeps a preview of its first page, read
 * out of it anywhere. A HEIC, HEIF, AVIF or TIFF picture is written out as
 * a JPEG by the pictures reader attachments use (sips in its sandbox on a
 * Mac, the pixels worker elsewhere). Each is kept under .kos/cache/thumbs
 * by the file's path, time and size, a miss included, so it is drawn once
 * per version. Documents and videos get their kind's mark: QuickLook,
 * which could draw them, will not run inside a sandbox, so KOS does not use it.
 */

const CACHE = ".kos/cache/thumbs";
/** Kept thumbnails past this are cleared, oldest first, down to half. */
const CACHE_FILES_MAX = 4000;
/** Past this a file is not read for a thumbnail. */
const THUMB_INPUT_MAX = 60 * 1024 * 1024;
export const THUMB_EDGES = [128, 256, 512] as const;

const IWORK = new Set([".pages", ".key", ".numbers"]);
/** Pictures a browser does not draw itself. */
const PICTURES = new Set([".heic", ".heif", ".avif", ".tiff", ".tif"]);

export interface Thumb {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
}

const drawPictures = limited(2, async (bytes: Buffer, edge: number, converter: Converter): Promise<Buffer | undefined> => {
  const type = imageTypeOf(bytes);
  if (!type) return undefined;
  const picture = await converter.open(bytes, type, IMAGE_MAX_PIXELS);
  try {
    return await picture.encode("image/jpeg", edge, 80);
  } finally {
    await picture.close();
  }
});

export async function thumbnail(ws: Workspace, rel: string, edge: number, converter: Converter = converterHere()): Promise<Thumb | undefined> {
  const abs = ws.resolve(rel);
  const st = statSync(abs);
  if (!st.isFile() || st.size > THUMB_INPUT_MAX) return undefined;
  const ext = extname(rel).toLowerCase();
  if (!IWORK.has(ext) && !PICTURES.has(ext)) return undefined;
  const key = createHash("sha256").update(`${rel}\0${st.mtimeMs}\0${st.size}\0${edge}`).digest("hex").slice(0, 32);
  const dir = ws.resolve(CACHE);
  const cached = join(dir, `${key}.img`);
  // A version no reader could draw is not asked about again.
  const none = join(dir, `${key}.none`);
  if (existsSync(none)) return undefined;
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    return { bytes, contentType: bytes[0] === 0xff ? "image/jpeg" : "image/png" };
  }
  const bytes = readFileSync(abs);
  let made: Thumb | undefined;
  if (IWORK.has(ext) && isZip(bytes)) {
    const preview = readZip(bytes, { only: (n) => n === "preview.jpg" || n === "preview-web.jpg" || n === "QuickLook/Thumbnail.jpg", entryMax: 8 * 1024 * 1024, totalMax: 24 * 1024 * 1024, oversize: "skip" });
    const jpeg = preview.get("preview-web.jpg") ?? preview.get("preview.jpg") ?? preview.get("QuickLook/Thumbnail.jpg");
    if (jpeg) made = { bytes: jpeg, contentType: "image/jpeg" };
  }
  if (PICTURES.has(ext)) {
    const jpeg = await drawPictures(bytes, edge, converter).catch(() => undefined);
    if (jpeg) made = { bytes: jpeg, contentType: "image/jpeg" };
  }
  keep(dir, made ? cached : none, made?.bytes ?? Buffer.alloc(0));
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
