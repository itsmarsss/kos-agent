import type { Converter } from "../files/images.js";
import { OfficeViewer } from "../files/viewer/viewer.js";
import type { Workspace } from "../store/workspace.js";
import { createReadStream } from "node:fs";

import { basename } from "node:path";

import { BadRange, fileInfo, readMedia, recentFiles, searchContents, searchNames } from "./fileinfo.js";
import { dispositionOf } from "./files.js";
import { emptyTrash, listTrash, restoreEntry, trashEntry } from "./filetrash.js";
import { THUMB_EDGES, thumbnail } from "./filethumbs.js";

/**
 * The file manager's routes beyond the ones server.ts has always had:
 * Office views, thumbnails, a file's facts, search, recents and the trash.
 * Each takes its path through the jail; the writes (trash, restore, empty)
 * also refuse the workspace's own files, as rename and copy do.
 */

export interface FilesRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The Range header, for a player seeking in a video. */
  range?: string;
}

export interface FilesResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** What a viewed or drawn file is served with: never sniffed, never a document on this origin. */
const INERT = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };

export interface FilesDeps {
  viewer: OfficeViewer;
  /** What writes a picture out at a size: the attachments' reader unless a test gives another. */
  pictures?: Converter;
  /** A project's name by its slug, for the Info panel. */
  projectName: (slug: string) => string | undefined;
}

let shared: OfficeViewer | undefined;

export function defaultFilesDeps(projectName: FilesDeps["projectName"]): FilesDeps {
  shared ??= new OfficeViewer();
  return { viewer: shared, projectName };
}

const bad = (err: unknown): FilesResponse => ({ status: 400, body: { error: err instanceof Error ? err.message : String(err) } });

/** The response, or undefined for a path that is not one of these routes. */
export async function handleFilesRoute(ws: Workspace, req: FilesRequest, deps: FilesDeps): Promise<FilesResponse | undefined> {
  const { method, path, query, body } = req;
  const target = query.get("path") ?? "";
  try {
    if (method === "GET" && path === "/api/file/office") {
      if (!target) return bad("path required");
      return { status: 200, body: await deps.viewer.view(ws.resolve(target), target), headers: { ...INERT, "content-disposition": dispositionOf("inline", basename(target)) } };
    }
    if (method === "GET" && path === "/api/file/thumb") {
      if (!target) return bad("path required");
      const asked = Number(query.get("size") ?? 256);
      const edge = THUMB_EDGES.find((e) => e >= asked) ?? 512;
      const thumb = await thumbnail(ws, target, edge, deps.pictures);
      if (!thumb) return { status: 404, body: { error: "no thumbnail for this file" } };
      return { status: 200, body: thumb.bytes, headers: { ...INERT, "content-type": thumb.contentType, "content-length": String(thumb.bytes.byteLength), "cache-control": "private, max-age=300" } };
    }
    if (method === "GET" && path === "/api/file/media") {
      if (!target) return bad("path required");
      let media;
      try {
        media = readMedia(ws, target, req.range);
      } catch (err) {
        if (err instanceof BadRange) return { status: 416, body: null, headers: { ...INERT, "content-range": `bytes */${err.size}` } };
        throw err;
      }
      return {
        status: media.partial ? 206 : 200,
        // Streamed from disk: a film is not read into memory to be sent.
        body: media.end < media.start ? Buffer.alloc(0) : createReadStream(media.path, { start: media.start, end: media.end }),
        headers: {
          ...INERT,
          "content-type": media.contentType,
          "content-length": String(media.end - media.start + 1),
          "accept-ranges": "bytes",
          ...(media.partial ? { "content-range": `bytes ${media.start}-${media.end}/${media.size}` } : {}),
        },
      };
    }
    if (method === "GET" && path === "/api/files/info") {
      const info = await fileInfo(ws, target || ".");
      const owner = /^projects\/([^/]+)/.exec(info.path)?.[1];
      const name = owner ? deps.projectName(owner) : undefined;
      return { status: 200, body: { ...info, ...(owner && name ? { project: { slug: owner, name } } : {}) } };
    }
    if (method === "GET" && path === "/api/files/search") {
      const q = query.get("q") ?? "";
      return { status: 200, body: query.get("contents") === "1" ? searchContents(ws, target || ".", q) : searchNames(ws, target || ".", q) };
    }
    if (method === "GET" && path === "/api/files/recents") return { status: 200, body: { entries: recentFiles(ws) } };
    if (method === "GET" && path === "/api/files/trash") return { status: 200, body: { items: listTrash(ws) } };
    if (method === "POST" && path === "/api/files/trash") return { status: 200, body: trashEntry(ws, body.path) };
    if (method === "POST" && path === "/api/files/restore") return { status: 200, body: restoreEntry(ws, body.id) };
    if (method === "POST" && path === "/api/files/empty-trash") {
      // Asked for by name, so a stray post with no body never empties everything.
      if (body.confirm !== true) return bad("emptying the trash needs confirm: true");
      return { status: 200, body: emptyTrash(ws, body.ids) };
    }
  } catch (err) {
    return bad(err);
  }
  return undefined;
}

