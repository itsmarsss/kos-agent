import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";

import type { Workspace } from "../store/workspace.js";
import { managedPath, refuseLayout } from "./files.js";

/**
 * The owner's trash for files, as the Artifacts page has one for artifacts.
 *
 * Moving to the trash is a rename into .kos/trash/files/<id>/, beside a note
 * of where the thing was, so a mistake is one Restore away and nothing is
 * gone until the owner empties the trash and says yes. The trash is under
 * .kos, which the file manager itself never touches and the agent's tools
 * refuse, so only these functions reach it.
 */

const TRASH = ".kos/trash/files";
/** Ids are made here and checked on the way back in: no path is ever read from one. */
const ID = /^\d{13}-[0-9a-f]{8}$/;

export interface TrashItem {
  id: string;
  /** Where it was, workspace-relative. */
  path: string;
  name: string;
  kind: "dir" | "file";
  size: number;
  trashedAt: number;
}

function trashDir(ws: Workspace): string {
  const dir = ws.resolve(TRASH);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Move a file or folder into the trash. */
export function trashEntry(ws: Workspace, requestPath: unknown, now = Date.now()): TrashItem {
  const { rel, abs } = managedPath(ws, requestPath);
  refuseLayout(rel);
  if (!existsSync(abs)) throw new Error(`no such file: ${rel}`);
  const st = statSync(abs);
  const id = `${now}-${randomBytes(4).toString("hex")}`;
  const holder = join(trashDir(ws), id);
  mkdirSync(holder);
  const item: TrashItem = { id, path: rel, name: basename(rel), kind: st.isDirectory() ? "dir" : "file", size: st.isFile() ? st.size : 0, trashedAt: now };
  renameSync(abs, join(holder, item.name));
  writeFileSync(join(trashDir(ws), `${id}.json`), JSON.stringify(item));
  return item;
}

/** What is in the trash, the latest first. A note whose thing is gone is not listed. */
export function listTrash(ws: Workspace): TrashItem[] {
  const dir = trashDir(ws);
  const items: TrashItem[] = [];
  for (const name of readdirSync(dir)) {
    const id = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !ID.test(id)) continue;
    try {
      const item = JSON.parse(readFileSync(join(dir, name), "utf8")) as TrashItem;
      if (item.id === id && existsSync(join(dir, id, item.name))) items.push(item);
    } catch {
      // A note that does not parse is not something to restore.
    }
  }
  return items.sort((a, b) => b.trashedAt - a.trashedAt);
}

function itemOf(ws: Workspace, id: unknown): TrashItem {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("no such item in the trash");
  const item = listTrash(ws).find((i) => i.id === id);
  if (!item) throw new Error("no such item in the trash");
  return item;
}

/** A name beside the original nothing has yet: "notes.md", then "notes (2).md". */
function freeName(ws: Workspace, rel: string): string {
  const dir = dirname(rel) === "." ? "" : dirname(rel);
  const ext = extname(rel);
  const stem = basename(rel, ext);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${dir ? `${dir}/` : ""}${n === 1 ? stem : `${stem} (${n})`}${ext}`;
    if (!existsSync(ws.resolve(candidate))) return candidate;
  }
  throw new Error("too many files of that name");
}

/** Put it back where it was, beside anything that took its name since; the folders it was in are made again if they went. */
export function restoreEntry(ws: Workspace, id: unknown): { path: string } {
  const item = itemOf(ws, id);
  const { rel } = managedPath(ws, item.path);
  const target = managedPath(ws, freeName(ws, rel));
  mkdirSync(dirname(target.abs), { recursive: true });
  const holder = join(trashDir(ws), item.id);
  renameSync(join(holder, item.name), target.abs);
  rmSync(holder, { recursive: true, force: true });
  rmSync(join(trashDir(ws), `${item.id}.json`), { force: true });
  return { path: target.rel };
}

/** Gone for good: the items named, or everything. The only hard delete the file manager has. */
export function emptyTrash(ws: Workspace, ids?: unknown): { removed: number } {
  const all = listTrash(ws);
  const wanted = Array.isArray(ids) ? all.filter((i) => ids.includes(i.id)) : all;
  for (const item of wanted) {
    rmSync(join(trashDir(ws), item.id), { recursive: true, force: true });
    rmSync(join(trashDir(ws), `${item.id}.json`), { force: true });
  }
  return { removed: wanted.length };
}
