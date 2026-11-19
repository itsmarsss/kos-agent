import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { JailedCommand, JailOptions } from "./jail.js";
import { holdPlaces } from "./placeholder.js";

/**
 * The jail on bare Linux: bubblewrap.
 *
 * macOS's sandbox checks each access against a profile. Bubblewrap instead
 * builds the program a filesystem of its own out of bind mounts, in fresh
 * namespaces, so the same JailOptions are said as what is there: the system
 * read-only, the workspace read-only or read-write, a fresh /tmp, and
 * nothing else of the host. What is hidden is covered over, what is
 * read-only is bound read-only over itself, and a pattern becomes the paths
 * that match it when the run starts.
 *
 * Every run gets new user, pid, ipc, uts, cgroup and network namespaces and
 * a session of its own, so it signals nothing, reaches no D-Bus (no /run),
 * and pushes nothing into the owner's terminal. A run without the network,
 * or kept to "local", has a loopback of its own: the host's ports, KOS's
 * among them, are in the host's namespace and out of reach. A run with the
 * network shares the host's, and KOS's ports are not refused there.
 */

/** Where bwrap is looked for: system places only, never a PATH the agent could put a program on. */
const BWRAP_PATHS = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];

/** The system, read-only. */
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt"];

/** What of /etc a program needs: users, names, certificates, the linker's cache, the time zone. */
const ETC = [
  "alternatives",
  "ca-certificates",
  "crypto-policies",
  "fonts",
  "group",
  "host.conf",
  "hosts",
  "ld.so.cache",
  "ld.so.conf",
  "ld.so.conf.d",
  "localtime",
  "mime.types",
  "nsswitch.conf",
  "passwd",
  "pki",
  "protocols",
  "resolv.conf",
  "services",
  "ssl",
];

/** Folders a pattern's walk does not enter: a dependency tree is no repository the owner runs git in. */
const NOT_WALKED = new Set(["node_modules"]);

/** Entries a pattern's walk looks at before refusing the run rather than leave one unheld. */
export const WALK_LIMIT = 200_000;

type Kind = "dir" | "file" | "link";

function kindOf(path: string): Kind | undefined {
  try {
    const s = lstatSync(path);
    return s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The system's binds: a merged /usr's links kept as links. */
function systemArgs(): string[] {
  const out: string[] = [];
  for (const path of SYSTEM) {
    const kind = kindOf(path);
    if (kind === "link") out.push("--symlink", readlinkSync(path), path);
    else if (kind === "dir") out.push("--ro-bind", path, path);
  }
  for (const name of ETC) out.push("--ro-bind-try", join("/etc", name), join("/etc", name));
  out.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  return out;
}

const BASE = ["--unshare-all", "--die-with-parent", "--new-session"];

let found: string | false | undefined;

/** True when this bwrap can build a jail here: user namespaces may be off, or held back by AppArmor. */
function works(bwrap: string): boolean {
  try {
    accessSync(bwrap, constants.X_OK);
  } catch {
    return false;
  }
  const run = spawnSync(bwrap, [...BASE, ...systemArgs(), "/bin/sh", "-c", "exit 0"], { stdio: "ignore", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  return run.status === 0;
}

/** The working bwrap on this Linux, found and tried once; undefined anywhere else or when none works. */
export function bubblewrap(): string | undefined {
  if (process.platform !== "linux") return undefined;
  found ??= BWRAP_PATHS.find(works) ?? false;
  return found || undefined;
}

/**
 * Cover a path: an empty folder over a folder, a device that cannot be
 * opened over a file. The folder is made read-only once every mount is in
 * place (see sealed), since a write bound back inside it needs its mount
 * point made there first.
 */
function cover(path: string, kind: Kind | undefined): string[] {
  if (kind === "dir") return ["--tmpfs", path];
  // Binds are nodev, so the null device mounted there refuses to open.
  if (kind === "file") return ["--ro-bind", "/dev/null", path];
  return [];
}

/** The covering folders among these mounts, made read-only. */
function sealed(mounts: string[]): string[] {
  return mounts.flatMap((m, i) => (m === "--tmpfs" && mounts[i + 1] !== "/tmp" ? ["--remount-ro", mounts[i + 1]!] : []));
}

/** True when no part of the path below the workspace is a link: one the agent planted could aim a bind anywhere. */
function unlinked(path: string): boolean {
  let at = path;
  while (!kindOf(at)) at = dirname(at);
  try {
    return realpathSync(at) === at;
  } catch {
    return false;
  }
}

/** Walk the trees, not following links; visit says whether to go into a folder. */
function walk(roots: string[], visit: (path: string, dir: boolean) => boolean): void {
  let seen = 0;
  const stack = [...roots];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > WALK_LIMIT) throw new Error(`too many files to jail here (over ${WALK_LIMIT}): narrow the folder the command runs for`);
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      const isDir = entry.isDirectory();
      if (visit(path, isDir) && isDir && !NOT_WALKED.has(entry.name)) stack.push(path);
    }
  }
}

/** The outermost of these paths: one inside another is walked with it. */
function outermost(paths: string[]): string[] {
  return paths.filter((p, i) => !paths.some((q, j) => j !== i && under(p, q) && (p !== q || j < i)));
}

/**
 * The bwrap command line for a program in the jail the options describe.
 * secretFiles are as resolved by the caller. A read-only path that is not
 * there is stood in for, and the command's release takes the stand-in away.
 */
export function bwrapCommand(bwrap: string, file: string, args: string[], options: JailOptions & { secretFiles: string[] }): JailedCommand {
  const given = resolve(options.workspaceRoot);
  const ws = realpathSync(given);
  // Paths below the workspace are spoken of as they really are, and the workspace is linked from where it was named.
  const rebase = (path: string): string => {
    const abs = resolve(path);
    return under(abs, given) ? join(ws, relative(given, abs)) : abs;
  };
  const inWs = (path: string): boolean => under(path, ws);
  // A path below the workspace through a link is one the agent may have aimed: it is not bound (macOS checks the real path too).
  const honest = (path: string): boolean => !inWs(path) || unlinked(path);
  const list = (paths: string[] | undefined): string[] => (paths ?? []).map(rebase).filter(honest);

  const writes = options.writes ? list(options.writes) : undefined;
  const hidden = list(options.hidden);
  const reads = (options.reads ?? []).map((p) => resolve(p));
  const writableWithin = list(options.writableWithin);
  const rwRoots = [...(writes ?? [ws]), ...writableWithin];
  const bound = [ws, ...reads, ...(writes ?? []), ...writableWithin];
  const visible = (path: string): boolean => !hidden.some((h) => under(path, h)) || (writes ?? []).some((w) => under(path, w));

  // Read-only paths in reach of the run. One not there is stood in for first, so the covers below find it there too.
  const readOnly = (options.readOnly ?? []).map(rebase).filter((p) => bound.some((root) => under(p, root)));
  for (const path of readOnly) {
    if (inWs(path) && !unlinked(path)) throw new Error(`${path} is reached through a link, which this jail cannot hold read-only`);
    if (kindOf(path) === "link") throw new Error(`${path} is a link, which this jail cannot hold read-only`);
  }
  const release = holdPlaces(readOnly.filter((p) => rwRoots.some((root) => under(dirname(p), root))));

  const mounts: string[] = [writes ? "--ro-bind" : "--bind", ws, ws];
  if (given !== ws) mounts.push("--symlink", ws, given);
  for (const path of reads) mounts.push("--ro-bind-try", path, path);
  // The program itself, wherever it was installed: a program cannot run unread.
  if (isAbsolute(file) && !bound.some((root) => under(file, root)) && !SYSTEM.some((root) => under(file, root))) mounts.push("--ro-bind-try", file, file);
  try {
    for (const path of hidden) mounts.push(...cover(path, kindOf(path)));
    for (const path of writes ?? []) if (kindOf(path) === "dir" || kindOf(path) === "file") mounts.push("--bind", path, path);
    for (const path of readOnly) if (visible(path) && kindOf(path)) mounts.push("--ro-bind", path, path);
    for (const path of writableWithin) if (visible(path) && kindOf(path) === "dir") mounts.push("--bind", path, path);
    // A bind is of the host's folder, so what was hidden inside one is covered again: writable is not readable.
    const rebound = [...readOnly, ...writableWithin].filter(visible);
    for (const path of hidden) if (!visible(path) && rebound.some((r) => r !== path && under(path, r))) mounts.push(...cover(path, kindOf(path)));

    const unwritable = (options.unwritable ?? []).map((r) => new RegExp(r));
    const unreadable = (options.unreadable ?? []).map((r) => new RegExp(r));
    if (unwritable.length || unreadable.length) {
      const frozen: string[] = [];
      // Writable: in reach of a write, and inside a read-only path only where a writable one is carved out of it.
      const writable = (path: string): boolean => {
        if (!rwRoots.some((root) => under(path, root)) || frozen.some((f) => under(path, f))) return false;
        const held = readOnly.filter((r) => under(path, r));
        return held.length === 0 || writableWithin.some((w) => under(path, w) && held.every((r) => under(w, r)));
      };
      walk(outermost(bound), (path, dir) => {
        if (!visible(path)) return false;
        if (unreadable.some((r) => r.test(path))) {
          mounts.push(...cover(path, dir ? "dir" : "file"));
          return false;
        }
        if (writable(path) && unwritable.some((r) => r.test(path))) {
          // A folder whose contents match too is held whole; one that only matches itself is pinned, so it cannot be moved or replaced.
          if (!dir || unwritable.some((r) => r.test(`${path}/x`))) {
            mounts.push("--ro-bind", path, path);
            if (dir) frozen.push(path);
          } else mounts.push("--bind", path, path);
        }
        return true;
      });
    }

    // Last, so nothing above uncovers them.
    for (const path of options.secretFiles.map((p) => resolve(p))) {
      if (bound.some((root) => under(path, root)) && visible(path)) mounts.push(...cover(path, kindOf(path)));
    }
  } catch (err) {
    release();
    throw err;
  }

  const net = options.network === false || options.network === "local" ? [] : ["--share-net"];
  return { file: bwrap, args: [...BASE, ...net, ...systemArgs(), ...mounts, ...sealed(mounts), file, ...args], release };
}
