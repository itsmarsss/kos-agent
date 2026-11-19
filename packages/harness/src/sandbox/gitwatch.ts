import { lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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

/** Move what was planted into the workspace's quarantine, with a note; the paths moved, from the workspace. */
export function quarantine(ws: string, planted: string[]): string[] {
  if (!planted.length) return [];
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const folder = join(ws, ".kos", "quarantine", stamp);
  const moved: string[] = [];
  for (const path of planted) {
    const rel = under(path, ws) ? relative(ws, path) : basename(path);
    try {
      mkdirSync(dirname(join(folder, rel)), { recursive: true });
      renameSync(path, join(folder, rel));
      moved.push(rel);
    } catch {
      // Gone already; nothing left to run.
    }
  }
  if (moved.length) {
    writeFileSync(
      join(folder, "NOTE.txt"),
      `A command run without the owner's approval made or changed git's own control (config, hooks and the like), which can name a program for git to run. It was moved here from the workspace:\n\n${moved.join("\n")}\n`,
    );
  }
  return moved;
}
