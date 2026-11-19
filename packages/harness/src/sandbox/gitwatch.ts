import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

/**
 * Git's control, watched across a run nobody approved.
 *
 * Bubblewrap holds a repository's config and hooks read-only by mounting
 * over what is there when the run starts. A repository the run makes, or
 * control a repository lacked (a config.worktree, a commondir, a hooks
 * folder) and the run adds, is not held: macOS's patterns refuse those,
 * bubblewrap cannot. So the control under the run's writable folders is
 * listed before it and after, and whatever is new or changed is moved into
 * .kos/quarantine, with a note, before the owner's next git command can run
 * what was planted there.
 */

/** What in a .git folder names a program or another repository to follow. */
const CONTROL = ["config", "config.worktree", "commondir", "hooks", "info", "modules", "worktrees"];

/** Folders a walk does not enter: a dependency tree is no repository the owner runs git in. */
const NOT_WALKED = new Set(["node_modules"]);

export type Controls = Map<string, string>;

function signature(path: string): string | undefined {
  try {
    const s = lstatSync(path);
    return `${s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : "f"}:${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return undefined;
  }
}

function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Every .git under the roots, and the control inside each .git folder, by signature. */
export function gitControls(roots: string[], limit: number): Controls {
  const out: Controls = new Map();
  let seen = 0;
  const stack = roots.filter((r, i) => !roots.some((q, j) => j !== i && under(r, q) && (r !== q || j < i)));
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > limit) throw new Error(`too many files to watch here (over ${limit}): narrow the folder the command runs for`);
      const path = join(dir, entry.name);
      if (entry.name === ".git") {
        const sig = signature(path);
        if (sig) out.set(path, sig);
        if (entry.isDirectory()) {
          for (const name of CONTROL) {
            const control = join(path, name);
            const s = signature(control);
            if (s) out.set(control, s);
          }
        }
        continue;
      }
      if (entry.isDirectory() && !NOT_WALKED.has(entry.name)) stack.push(path);
    }
  }
  return out;
}

/**
 * What a run made or changed in git's control: a .git that is new, a .git
 * file or link that changed, or control inside a kept .git folder that is
 * new or changed. A .git folder's own times change with every commit, so
 * they are not compared.
 */
export function plantedControls(before: Controls, after: Controls): string[] {
  const planted: string[] = [];
  for (const [path, sig] of after) {
    const was = before.get(path);
    if (basename(path) === ".git") {
      const folder = sig.startsWith("d:");
      if (!was || was.startsWith("d:") !== folder || (!folder && was !== sig)) planted.push(path);
    } else if (was !== sig) planted.push(path);
  }
  // A whole .git moved takes what is in it.
  return planted.filter((p) => !planted.some((q) => q !== p && under(p, q)));
}

/** What a quarantine did: the paths moved or removed, and those it could not take away, from the workspace. */
export interface Quarantined {
  moved: string[];
  failed: string[];
}

/** Planted control that could not be taken away: no unapproved run goes into its repository again while it stands. */
const stuck = new Set<string>();

/** The repository a control path belongs to: the folder holding its .git. */
function repoOf(path: string): string {
  const at = path.lastIndexOf("/.git");
  return at > 0 ? path.slice(0, at) : dirname(path);
}

/** A tree an unapproved run would write in that still holds control a quarantine could not take away. */
export function stuckUnder(roots: string[]): string | undefined {
  for (const path of [...stuck]) {
    if (!lstatOf(path)) {
      stuck.delete(path);
      continue;
    }
    const repo = repoOf(path);
    if (roots.some((root) => under(repo, root) || under(root, repo))) return path;
  }
  return undefined;
}

function lstatOf(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Give a folder back its owner's rwx without following a link to it: the run may have locked it with chmod. */
function unlock(dir: string): void {
  try {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      fchmodSync(fd, (fstatSync(fd).mode & 0o7777) | 0o700);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not a folder, or not there: nothing to unlock.
  }
}

/** Unlock every folder in a tree, outermost first, following no link. */
function unlockTree(path: string): void {
  if (!lstatOf(path)?.isDirectory()) return;
  unlock(path);
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) if (entry.isDirectory()) unlockTree(join(path, entry.name));
}

/** Move one planted path out; failing that, remove it; say which, or that it is stuck there. */
function takeAway(path: string, dest: string): "moved" | "removed" | "gone" | "stuck" {
  const move = (): NodeJS.ErrnoException | undefined => {
    try {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(path, dest);
      return undefined;
    } catch (err) {
      return err as NodeJS.ErrnoException;
    }
  };
  let err = move();
  if (!err) return "moved";
  if (err.code === "ENOENT" && !lstatOf(path)) return "gone";
  // Locked by the run (chmod 555), or on another disk: unlocked and tried again, then removed outright.
  unlock(dirname(path));
  unlock(path);
  err = move();
  if (!err) return "moved";
  unlockTree(path);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Reported below, if it is still there.
  }
  return lstatOf(path) ? "stuck" : "removed";
}

/**
 * Move what was planted into the workspace's quarantine, with a note. What
 * cannot be moved is removed; what cannot be removed either is reported,
 * and no unapproved run goes into its tree again while it stands.
 */
export function quarantine(ws: string, planted: string[]): Quarantined {
  const done: Quarantined = { moved: [], failed: [] };
  if (!planted.length) return done;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const folder = join(ws, ".kos", "quarantine", stamp);
  const removed: string[] = [];
  for (const path of planted) {
    const rel = under(path, ws) ? relative(ws, path) : basename(path);
    const how = takeAway(path, join(folder, rel));
    if (how === "moved") done.moved.push(rel);
    else if (how === "removed") {
      done.moved.push(rel);
      removed.push(rel);
    } else if (how === "stuck") {
      done.failed.push(rel);
      stuck.add(path);
    }
  }
  if (done.moved.length) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "NOTE.txt"),
      `A command run without the owner's approval made or changed git's own control (config, hooks and the like), which can name a program for git to run. It was moved here from the workspace${removed.length ? " (what could not be moved was deleted: " + removed.join(", ") + ")" : ""}:\n\n${done.moved.join("\n")}\n`,
    );
  }
  if (done.failed.length) console.error(`[jail] planted git control could not be taken away; unapproved runs there are refused until the owner removes it: ${done.failed.join(", ")}`);
  return done;
}
