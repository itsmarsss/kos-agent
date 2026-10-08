import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";

import { PROJECTS_DIR } from "../sites/server.js";
import type { Workspace } from "../store/workspace.js";

/**
 * A file the owner put into a project from the dashboard.
 *
 * The file browser is read-only on purpose; this is the one write it makes
 * room for, and it is kept to the project's own folder. The name is reduced
 * to its last segment before it meets the jail, so "../x" and "a/b" both
 * land as a file in the folder: nothing a browser sends can name a path.
 * A folder inside the project may be named separately, and is checked to
 * still be inside the project once normalised.
 */

export interface Upload {
  name: string;
  /** Base64 payload, without the data: prefix. */
  data: string;
  /** A folder inside the project to put it in; the project's root when empty. */
  dir: string;
}

/** Same ceiling as a chat attachment: this is a reference, not a backup. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface WrittenFile {
  /** Workspace-relative path, forward-slashed. */
  path: string;
  size: number;
}

export function parseUpload(raw: Record<string, unknown>): Upload {
  const name = typeof raw["name"] === "string" ? raw["name"] : "";
  const data = typeof raw["data"] === "string" ? raw["data"] : "";
  const dir = typeof raw["dir"] === "string" ? raw["dir"] : "";
  if (!name.trim()) throw new Error("name required");
  if (!data) throw new Error(`${name} has no content`);
  return { name, data, dir };
}

/** The last segment of whatever was sent, or a refusal when there is none. */
export function uploadName(name: string): string {
  const last = posix.basename(name.replace(/\\/g, "/")).trim();
  if (last === "" || last === "." || last === ".." || last.includes("\0")) {
    throw new Error(`not a file name: ${name}`);
  }
  return last;
}

/**
 * Where inside the project an upload lands: the project's folder, or a
 * folder under it. Normalised first, so "sub/../../other" is seen for what
 * it is and refused rather than landing in another project.
 */
export function uploadDir(slug: string, dir: string): string {
  const root = `${PROJECTS_DIR}/${slug}`;
  const clean = dir.replace(/\\/g, "/").trim().replace(/\/+$/, "");
  if (clean === "" || clean === ".") return root;
  // An absolute path is not a folder inside anything; it is refused rather
  // than quietly read as relative.
  if (clean.startsWith("/") || clean.includes("\0")) throw new Error(`not a folder in the project: ${dir}`);
  const rel = posix.normalize(posix.join(root, clean));
  if (rel !== root && !rel.startsWith(`${root}/`)) {
    throw new Error(`${dir} is not inside the project`);
  }
  return rel;
}

export function writeProjectFile(ws: Workspace, slug: string, upload: Upload): WrittenFile {
  const name = uploadName(upload.name);
  // Sized from the encoding before decoding, so an oversize body is refused
  // without first being turned into the bytes it was too big to be.
  const approx = Math.floor((upload.data.length * 3) / 4);
  if (approx > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${name} is ${Math.round(approx / 1024 / 1024)}MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
    );
  }
  const bytes = Buffer.from(upload.data, "base64");
  const rel = `${uploadDir(slug, upload.dir)}/${name}`;
  const abs = ws.resolve(rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return { path: rel, size: bytes.byteLength };
}
