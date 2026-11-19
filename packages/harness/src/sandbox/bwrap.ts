import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gitControls, plantedControls, quarantine } from "./gitwatch.js";
import type { JailedCommand, JailOptions } from "./jail.js";
import type { JailNat, JailPlan } from "./jailrun.js";
import { holdPlaces, type Place } from "./placeholder.js";
import { seccompFilter } from "./seccomp.js";
import { findTrusted } from "./trusted.js";

/**
 * The jail on bare Linux: bubblewrap.
 *
 * macOS's sandbox checks each access against a profile. Bubblewrap instead
 * builds the program a filesystem of its own out of bind mounts, in fresh
 * namespaces, so the same JailOptions are said as what is there: the system
 * read-only, the workspace read-only or read-write, a fresh /tmp, and
 * nothing else of the host. What is hidden is covered over, what is
 * read-only is bound read-only over itself, a pattern becomes the paths
 * that match it when the run starts, and every folder between a writable
 * one and what is held is pinned, so none can be renamed out from over it.
 *
 * Every run gets new user, pid, ipc, uts, cgroup and network namespaces, a
 * session of its own, no further user namespaces, and a seccomp filter
 * (seccomp.ts), so it signals nothing, reaches no D-Bus (no /run), and
 * pushes nothing into the owner's terminal. Its network is its own: only a
 * loopback without the network, or kept to "local"; with the network, a NAT
 * of its own through pasta or slirp4netns (jailrun.ts), the host's loopback
 * out of reach either way, so KOS's ports, its Chrome's among them, and the
 * host's abstract sockets are not there.
 */

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

/** A run's /tmp, in memory: capped. A cover holds nothing. */
const TMP_BYTES = 1024 ** 3;
const COVER_BYTES = 64 * 1024;

/** The oldest bubblewrap that binds by descriptor and can refuse further user namespaces. */
const OLDEST = [0, 8, 0];

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

/** Strictly inside. */
function within(path: string, root: string): boolean {
  return path !== root && under(path, root);
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
  out.push("--dev", "/dev", "--proc", "/proc", "--size", String(TMP_BYTES), "--tmpfs", "/tmp");
  return out;
}

const BASE = ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session"];
const NO_USERNS = ["--disable-userns", "--assert-userns-disabled"];

/** A version's numbers, from `bwrap --version`. */
export function versionOf(said: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(said);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function atLeast(version: number[], oldest: number[]): boolean {
  for (let i = 0; i < oldest.length; i++) if ((version[i] ?? 0) !== oldest[i]) return (version[i] ?? 0) > oldest[i]!;
  return true;
}

let found: string | false | undefined;
/** Whether the bwrap found refuses the sandbox further user namespaces; the seccomp filter refuses them regardless. */
let refusesUserns = true;

/** Whether this bwrap is new enough and can build a jail here (user namespaces may be off, or held back by AppArmor), and with which flags. */
function works(bwrap: string): "full" | "plain" | false {
  const said = spawnSync(bwrap, ["--version"], { encoding: "utf8", timeout: 5000 });
  const version = versionOf(said.stdout ?? "");
  if (!version || !atLeast(version, OLDEST)) return false;
  const tryRun = (extra: string[]): boolean =>
    spawnSync(bwrap, [...BASE, ...extra, ...systemArgs(), "/bin/sh", "-c", "exit 0"], { stdio: "ignore", timeout: 5000, env: { PATH: "/usr/bin:/bin" } }).status === 0;
  return tryRun(NO_USERNS) ? "full" : tryRun([]) ? "plain" : false;
}

/**
 * The working bwrap on this Linux, found and tried once; undefined anywhere
 * else, when none is trusted and works, or for a machine with no seccomp
 * filter here.
 */
export function bubblewrap(): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (found === undefined) {
    const bwrap = seccompFilter() ? findTrusted("bwrap") : undefined;
    const how = bwrap ? works(bwrap) : false;
    refusesUserns = how === "full";
    found = how ? bwrap! : false;
  }
  return found || undefined;
}

let ownNamespaces: boolean | undefined;

/**
 * The NAT a networked run is given its own network through: pasta, else
 * slirp4netns; undefined without either, or where unshare may not make the
 * run's namespaces for it to serve (AppArmor holds user namespaces back
 * from programs it has no profile for).
 */
export function natTool(): JailNat | undefined {
  const unshare = findTrusted("unshare");
  ownNamespaces ??= !!unshare && spawnSync(unshare, ["--user", "--net", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;
  if (!ownNamespaces) return undefined;
  const pasta = findTrusted("pasta");
  if (pasta) return { tool: "pasta", path: pasta };
  const slirp = findTrusted("slirp4netns");
  return slirp ? { tool: "slirp4netns", path: slirp } : undefined;
}

let privateDir: string | undefined;

/** A folder only this process's user can enter, holding the seccomp filter, for the runs' own scratch. */
function scratch(): { dir: string; seccomp: string } {
  if (!privateDir) {
    privateDir = mkdtempSync(join(tmpdir(), "kos-jail-"));
    chmodSync(privateDir, 0o700);
    writeFileSync(join(privateDir, "seccomp.bpf"), seccompFilter() ?? Buffer.alloc(0), { mode: 0o600 });
  }
  return { dir: privateDir, seccomp: join(privateDir, "seccomp.bpf") };
}

/** The helper every run starts through, from its source under the tests and its build otherwise. */
function helper(): string[] {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts") ? ["--experimental-strip-types", "--no-warnings", join(dirname(here), "jailrun.ts")] : [join(dirname(here), "jailrun.js")];
}

/**
 * Cover a path: an empty folder over a folder, a device that cannot be
 * opened over a file. The folder is made read-only once every mount is in
 * place (see sealed), since a write bound back inside it needs its mount
 * point made there first.
 */
function cover(path: string, kind: Kind | undefined): string[] {
  if (kind === "dir") return ["--size", String(COVER_BYTES), "--tmpfs", path];
  // Binds are nodev, so the null device mounted there refuses to open.
  if (kind === "file") return ["--ro-bind", "/dev/null", path];
  return [];
}

/** The covering folders among these arguments, made read-only. */
function sealed(args: Array<string | number>): string[] {
  return args.flatMap((a, i) => (a === "--tmpfs" && args[i + 1] !== "/tmp" ? ["--remount-ro", String(args[i + 1])] : []));
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

interface Mount {
  dest: string;
  args: Array<string | number>;
}

export interface BwrapOptions extends JailOptions {
  secretFiles: string[];
}

/**
 * The command for a program in the jail the options describe: the helper,
 * with bwrap's plan. A read-only path that is not there is stood in for,
 * and the command's release takes the stand-in away, and, after a run
 * nobody approved, quarantines what it planted in git's control.
 */
export function bwrapCommand(bwrap: string, file: string, args: string[], options: BwrapOptions): JailedCommand {
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
  const secrets = options.secretFiles.map((p) => resolve(p));
  const rwRoots = [...(writes ?? [ws]), ...writableWithin];
  const bound = [ws, ...reads, ...(writes ?? []), ...writableWithin];
  const visible = (path: string): boolean => !hidden.some((h) => under(path, h)) || (writes ?? []).some((w) => under(path, w));
  const secret = (path: string): boolean => secrets.some((s) => under(path, s));

  // Read-only paths in reach of the run; one named with a trailing slash is a folder.
  const readOnly: Place[] = (options.readOnly ?? []).map((p) => ({ path: rebase(p), dir: p.endsWith("/") })).filter((p) => bound.some((root) => under(p.path, root)));
  for (const { path } of readOnly) {
    if (inWs(path) && !unlinked(path)) throw new Error(`${path} is reached through a link, which this jail cannot hold read-only`);
    if (kindOf(path) === "link") throw new Error(`${path} is a link, which this jail cannot hold read-only`);
  }
  // One not there is stood in for first, so the covers below find it there too.
  const release = holdPlaces(ws, readOnly.filter((p) => rwRoots.some((root) => under(dirname(p.path), root))));
  try {
    const sources: Place[] = [];
    const mounts: Mount[] = [];
    const covered: string[] = [];
    const bind = (op: "--bind" | "--ro-bind", path: string): void => {
      sources.push({ path, dir: kindOf(path) === "dir" });
      mounts.push({ dest: path, args: [`${op}-fd`, sources.length - 1, path] });
    };
    const hide = (path: string, kind: Kind | undefined): void => {
      const a = cover(path, kind);
      if (a.length) mounts.push({ dest: path, args: a });
      covered.push(path);
    };
    // A bind of what is secret, or inside what is covered (but for a write bound back inside it), would uncover it.
    const bindable = (path: string): boolean =>
      !secret(path) && !covered.some((c) => under(path, c) && !(writes ?? []).some((w) => within(w, c) && under(path, w)));

    bind(writes ? "--ro-bind" : "--bind", ws);
    for (const path of hidden) if (!visible(path)) hide(path, kindOf(path));
    for (const path of writes ?? []) if (!secret(path) && (kindOf(path) === "dir" || kindOf(path) === "file")) bind("--bind", path);
    const held = readOnly.map((p) => p.path).filter((p) => kindOf(p) && visible(p) && bindable(p));
    for (const path of held) bind("--ro-bind", path);
    for (const path of writableWithin) if (visible(path) && bindable(path) && kindOf(path) === "dir") bind("--bind", path);

    const roHeld = readOnly.map((p) => p.path);
    const frozen: string[] = [];
    // Writable: in reach of a write, and inside a read-only path only where a writable one is carved out of it.
    const writable = (path: string): boolean => {
      if (!rwRoots.some((root) => under(path, root)) || frozen.some((f) => under(path, f))) return false;
      const over = roHeld.filter((r) => under(path, r));
      return over.length === 0 || writableWithin.some((w) => under(path, w) && over.every((r) => under(w, r)));
    };

    const unwritable = (options.unwritable ?? []).map((r) => new RegExp(r));
    const unreadable = (options.unreadable ?? []).map((r) => new RegExp(r));
    if (unwritable.length || unreadable.length) {
      walk(outermost(bound), (path, dir) => {
        if (!visible(path) || secret(path)) return false;
        if (unreadable.some((r) => r.test(path))) {
          hide(path, dir ? "dir" : "file");
          return false;
        }
        if (writable(path) && unwritable.some((r) => r.test(path))) {
          // A folder whose contents match too is held whole; one that only matches itself is pinned, so it cannot be moved or replaced.
          if (!dir || unwritable.some((r) => r.test(`${path}/x`))) {
            bind("--ro-bind", path);
            held.push(path);
            if (dir) frozen.push(path);
          } else {
            bind("--bind", path);
            held.push(path);
          }
        }
        return true;
      });
    }

    // Every folder between a writable root and what is held, pinned to itself: a folder that is a mount cannot be renamed.
    const pins = new Set<string>();
    for (const path of held) {
      for (let dir = dirname(path); rwRoots.some((root) => within(dir, root)); dir = dirname(dir)) {
        if (writable(dir) && bindable(dir) && !held.includes(dir)) pins.add(dir);
      }
    }
    for (const dir of pins) bind("--bind", dir);

    for (const path of secrets) if (bound.some((root) => under(path, root)) && visible(path)) hide(path, kindOf(path));

    // Outer mounts before inner ones, as said otherwise: one laid later over an inner mount would hide it.
    const depth = (m: Mount): number => m.dest.split("/").length;
    const laid = mounts.sort((a, b) => depth(a) - depth(b)).flatMap((m) => m.args);

    const prefix: string[] = [];
    if (given !== ws) prefix.push("--symlink", ws, given);
    for (const path of reads) prefix.push("--ro-bind-try", path, path);
    // The program itself, wherever it was installed: a program cannot run unread.
    if (isAbsolute(file) && !bound.some((root) => under(file, root)) && !SYSTEM.some((root) => under(file, root))) prefix.push("--ro-bind-try", file, file);

    const networked = options.network !== false && options.network !== "local";
    const nat = networked ? (options.nat === undefined ? natTool() : options.nat || undefined) : undefined;
    const prlimit = findTrusted("prlimit");
    const mkfifo = findTrusted("mkfifo") ?? "/usr/bin/mkfifo";
    const unshare = findTrusted("unshare") ?? "/usr/bin/unshare";
    const { dir, seccomp } = scratch();
    const plan: JailPlan = {
      bwrap,
      args: [...BASE, ...(refusesUserns ? NO_USERNS : []), ...systemArgs(), ...prefix, ...laid, ...sealed(laid)],
      sources,
      seccomp,
      scratch: dir,
      networked,
      mkfifo,
      unshare,
      ...(nat ? { nat } : {}),
      ...(prlimit ? { prlimit } : {}),
      command: [file, ...args],
    };

    // A run nobody approved has git's control watched: what it plants is moved out before anyone's git runs it.
    const watched = unwritable.length ? rwRoots : [];
    const before = watched.length ? gitControls(watched, WALK_LIMIT) : undefined;
    let ended = false;
    const done = (): string[] => {
      if (ended) return [];
      ended = true;
      try {
        return before ? quarantine(ws, plantedControls(before, gitControls(watched, WALK_LIMIT))) : [];
      } finally {
        release();
      }
    };
    return { file: process.execPath, args: [...helper(), JSON.stringify(plan)], release: done };
  } catch (err) {
    release();
    throw err;
  }
}
