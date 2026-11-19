import { lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Stand-ins for read-only paths that are not there yet.
 *
 * macOS's sandbox denies writing a path whether or not it exists, so a run
 * cannot create a KOS settings file the host would then read. Bubblewrap
 * holds a path read-only by mounting over it, and a mount needs something to
 * mount on: a missing mcp.json in a writable workspace would be the run's to
 * create. So the host puts an empty one there for the run's length, mounts
 * over it, and takes it away after, unless something has since written it.
 * Runs at once share one stand-in, counted, so the first to end does not take
 * it from under the others.
 */

interface Held {
  count: number;
  ino: number;
  content: string;
  /** Folders made to hold it, deepest first. */
  dirs: string[];
}

const held = new Map<string, Held>();

/** What a stand-in holds: nothing, or for JSON an empty object, which a reader parses as no settings. */
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

/** The missing folders above a path, deepest first. */
function missingDirs(path: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(path); !exists(dir); dir = dirname(dir)) out.push(dir);
  return out;
}

/** Put a stand-in at each path not there; the release takes them away again. */
export function holdPlaces(paths: string[]): () => void {
  const mine: string[] = [];
  for (const path of paths) {
    const entry = held.get(path);
    if (entry) {
      entry.count += 1;
      mine.push(path);
      continue;
    }
    if (exists(path)) continue;
    const dirs = missingDirs(path);
    for (const dir of [...dirs].reverse()) mkdirSync(dir);
    const content = contentFor(path);
    writeFileSync(path, content, { flag: "wx" });
    held.set(path, { count: 1, ino: statSync(path).ino, content, dirs });
    mine.push(path);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const path of mine) release(path);
  };
}

function release(path: string): void {
  const entry = held.get(path);
  if (!entry || --entry.count > 0) return;
  held.delete(path);
  try {
    // Only the stand-in as it was put there: the host may have written the real file into it since.
    if (statSync(path).ino === entry.ino && readFileSync(path, "utf8") === entry.content) unlinkSync(path);
  } catch {
    // Gone already, or no longer a file: nothing of ours to take away.
  }
  for (const dir of entry.dirs) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty: something else lives there now.
    }
  }
}
