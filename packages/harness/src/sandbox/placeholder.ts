import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { openExact } from "./jailrun.js";

/**
 * Stand-ins for read-only paths that are not there yet.
 *
 * macOS's sandbox denies writing a path whether or not it exists, so a run
 * cannot create a KOS settings file the host would then read. Bubblewrap
 * holds a path read-only by mounting over it, and a mount needs something to
 * mount on: a missing mcp.json in a writable workspace would be the run's to
 * create. So the host puts an empty one there (an empty folder for a folder)
 * for the run's length, mounts over it, and takes it away after, unless
 * something has since written it. Runs at once share one stand-in, counted,
 * so the first to end does not take it from under the others.
 *
 * Each is made without following a link, and listed in the workspace's
 * .kos/standins.json while it stands, so one a crash left behind is taken
 * away the next time the workspace jails a run.
 */

export interface Place {
  path: string;
  dir: boolean;
}

interface Held {
  count: number;
  ino: number;
  dir: boolean;
  /** Folders made to hold it, deepest first. */
  made: string[];
}

const held = new Map<string, Held>();
const swept = new Set<string>();

/** What a file stand-in holds: nothing, or for JSON an empty object, which a reader parses as no settings. */
function contentFor(path: string): string {
  return path.endsWith(".json") ? "{}\n" : "";
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function ledgerOf(ws: string): string {
  return join(ws, ".kos", "standins.json");
}

/** The stand-ins of a workspace, as the ledger lists them: the folders made for them too. */
function record(ws: string): void {
  const places: Place[] = [];
  for (const [path, entry] of held) {
    if (!inside(path, ws)) continue;
    places.push({ path, dir: entry.dir }, ...entry.made.map((d) => ({ path: d, dir: true })));
  }
  mkdirSync(join(ws, ".kos"), { recursive: true });
  writeFileSync(ledgerOf(ws), `${JSON.stringify(places)}\n`);
}

/** Take a stand-in away: only an empty folder, or a file still as a stand-in is made. */
function remove(place: Place): void {
  try {
    if (place.dir) {
      rmdirSync(place.path);
      return;
    }
    const s = lstatSync(place.path);
    if (s.isFile() && s.size <= 3 && readFileSync(place.path, "utf8") === contentFor(place.path)) unlinkSync(place.path);
  } catch {
    // Not empty, not ours, or gone: left as it is.
  }
}

/** Stand-ins a crash left behind in this workspace, taken away once per process. */
function sweep(ws: string): void {
  if (swept.has(ws)) return;
  swept.add(ws);
  let listed: Place[] = [];
  try {
    listed = JSON.parse(readFileSync(ledgerOf(ws), "utf8")) as Place[];
  } catch {
    return;
  }
  // Files before the folders made for them, deepest folders first.
  const stale = listed.filter((p) => typeof p?.path === "string" && inside(p.path, ws) && !held.has(p.path));
  for (const place of stale.sort((a, b) => Number(a.dir) - Number(b.dir) || b.path.length - a.path.length)) remove(place);
  record(ws);
}

/** Make one stand-in, or nothing when something is there by then; it must be where it was named. */
function make(place: Place): number | undefined {
  try {
    if (place.dir) mkdirSync(place.path);
    else {
      const fd = openSync(place.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
      try {
        writeSync(fd, contentFor(place.path));
      } finally {
        closeSync(fd);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw err;
  }
  try {
    closeSync(openExact(place.path, place.dir));
  } catch (err) {
    remove(place);
    throw err;
  }
  return statSync(place.path).ino;
}

function release(path: string): void {
  const entry = held.get(path);
  if (!entry || --entry.count > 0) return;
  held.delete(path);
  try {
    // Only the stand-in as it was put there: the host may have written the real file into it since.
    if (lstatSync(path).ino === entry.ino) remove({ path, dir: entry.dir });
  } catch {
    // Gone already.
  }
  for (const dir of entry.made) remove({ path: dir, dir: true });
}

/** Put a stand-in at each place not there; the release takes them away again. */
export function holdPlaces(ws: string, places: Place[]): () => void {
  sweep(ws);
  const mine: string[] = [];
  const undo = (): void => {
    for (const path of mine.splice(0)) release(path);
    record(ws);
  };
  try {
    for (const place of places) {
      const entry = held.get(place.path);
      if (entry) {
        entry.count += 1;
        mine.push(place.path);
        continue;
      }
      if (exists(place.path)) continue;
      const missing: string[] = [];
      for (let dir = dirname(place.path); !exists(dir); dir = dirname(dir)) missing.unshift(dir);
      const made = missing.filter((dir) => make({ path: dir, dir: true }) !== undefined).reverse();
      const ino = make(place);
      if (ino === undefined) {
        for (const dir of made) remove({ path: dir, dir: true });
        continue;
      }
      held.set(place.path, { count: 1, ino, dir: place.dir, made });
      mine.push(place.path);
    }
    if (mine.length) record(ws);
  } catch (err) {
    undo();
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mine.length) undo();
  };
}
