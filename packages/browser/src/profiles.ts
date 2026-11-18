import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway Chrome profiles left in the temp folder.
 *
 * Every Chrome KOS starts for a moment (a check, an export, a script, a test)
 * gets a kos-* folder in the temp folder and deletes it once that Chrome
 * exits. A host that stopped before its Chrome did leaves the folder behind,
 * and a Chrome profile is many files; a host that crashed leaves the Chrome
 * running too, in a process group of its own that nothing will stop. The
 * sweep finds them, and only Chrome profiles:
 *
 * - one whose lock names a process that is gone;
 * - one KOS made whose lock names a Chrome left orphaned (its parent gone,
 *   so it is launchd's) and started on exactly that folder: that Chrome is
 *   stopped, its group with it, and then the folder goes;
 * - an unlocked one a day old with Chrome's own files in it, that no running
 *   process names as its profile.
 *
 * A Chrome whose parent is alive, or that names another folder, is never
 * touched; nor is a symlink, a folder Chrome did not write, or anything not
 * named kos-*.
 */

const PREFIX = "kos-";
/** The profiles KOS's own Chromes are started on: the checker's, the scripts', the tests'. */
const KOS_CHROMES = [
  "kos-check-",
  "kos-headless-",
  "kos-bench-",
  "kos-eval-chrome-",
  "kos-artifact-chrome-",
  "kos-presenter-chrome-",
  "kos-extension-",
  "kos-sealed-",
  "kos-hands-",
  "kos-page-",
];
/** How old an unlocked folder must be before it is taken for left behind. */
const UNLOCKED_MS = 24 * 60 * 60 * 1000;
/** How long an orphaned Chrome sent SIGTERM has before it is killed. */
const ORPHAN_GRACE_MS = 3000;
/** Folders deleted at once: a first sweep can be hundreds of them, and the deletes share Node's thread pool with the host. */
const DELETES_AT_ONCE = 2;
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;

/** A running process, as ps shows it. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  args: string;
}

export interface SweepOptions {
  /** The folder to sweep. The system's temp folder by default. */
  dir?: string;
  now?: number;
  /** Test seam: the running processes, or undefined when they cannot be read. */
  processes?: () => Promise<ProcessInfo[] | undefined>;
}

export interface SweepResult {
  /** The folders deleted. */
  removed: string[];
  /** The bytes they held. */
  freed: number;
  /** Folders that could not be deleted, and why. */
  failed: { path: string; error: string }[];
  /** Orphaned Chromes stopped, by pid. */
  stopped: number[];
}

/** Whether a process is running: signal 0 checks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Until a process has gone, or the time is up. Whether it went. */
async function gone(pid: number, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) if (!alive(pid)) return true;
  return !alive(pid);
}

function signal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch {
    /* gone */
  }
}

/** The pid Chrome's lock names (it links to host-pid), or undefined when there is no readable lock. */
function lockPid(profile: string): number | undefined {
  try {
    const pid = Number(readlinkSync(join(profile, "SingletonLock")).split("-").pop());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a folder holds what Chrome writes into every profile it opens. */
const chromeWrote = (profile: string): boolean => existsSync(join(profile, "Local State")) || existsSync(join(profile, "Default"));

const collapse = (path: string): string => path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");

/** Every spelling of a folder a command line might use: as given, resolved, and with or without macOS's /private. */
function spellings(path: string): Set<string> {
  const forms = new Set([collapse(path)]);
  try {
    forms.add(collapse(realpathSync(path)));
  } catch {
    /* gone */
  }
  for (const form of [...forms]) {
    if (/^\/private\/(var|tmp)\//.test(form)) forms.add(form.slice("/private".length));
    else if (/^\/(var|tmp)\//.test(form)) forms.add(`/private${form}`);
  }
  return forms;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a command line starts Chrome on this very folder, as --user-data-dir=<it> or --user-data-dir <it>. */
export function namesProfile(args: string, path: string): boolean {
  const line = collapse(args);
  return [...spellings(path)].some((form) => new RegExp(`--user-data-dir[= ]${escape(form)}/?(\\s|$)`).test(line));
}

/** Every running process, or undefined when they cannot be read. */
const processTable = (): Promise<ProcessInfo[] | undefined> =>
  new Promise((resolve) => {
    execFile("ps", ["-axww", "-o", "pid=,ppid=,pgid=,args="], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(undefined);
      resolve(
        out.split("\n").flatMap((line) => {
          const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
          return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4]! }] : [];
        }),
      );
    });
  });

/**
 * The process holding a profile, if it is, right now, a Chrome orphaned on
 * exactly that profile: still the pid its lock names, its parent launchd, and
 * started on that folder. Never this process, nor a child of it.
 */
async function orphanOn(path: string, pid: number, processes: () => Promise<ProcessInfo[] | undefined>): Promise<ProcessInfo | undefined> {
  if (pid === process.pid || process.pid === 1 || lockPid(path) !== pid) return undefined;
  const proc = (await processes())?.find((p) => p.pid === pid);
  if (!proc || proc.ppid !== 1 || proc.ppid === process.pid || !namesProfile(proc.args, path)) return undefined;
  return proc;
}

/**
 * Stop a Chrome orphaned on a profile. Each step is taken only while the
 * process is still that orphan: the pid could have gone and been reused
 * since the folder was read. The browser alone is asked first, as KOS stops
 * its own; then it is killed, with its group when it leads one (as KOS starts
 * it) and alone when it does not, never a group someone else leads. Whether
 * it went.
 */
async function stopOrphan(path: string, pid: number, processes: () => Promise<ProcessInfo[] | undefined>): Promise<boolean> {
  const proc = await orphanOn(path, pid, processes);
  if (!proc) return false;
  const leads = proc.pgid === proc.pid;
  signal(pid, "SIGTERM");
  if (!(await gone(pid, ORPHAN_GRACE_MS))) {
    if (!(await orphanOn(path, pid, processes))) return false;
    signal(leads ? -pid : pid, "SIGKILL");
    if (!(await gone(pid, ORPHAN_GRACE_MS))) return false;
  }
  // Its helpers, while any of its group still names the profile.
  if (leads && (await processes())?.some((p) => p.pgid === pid && namesProfile(p.args, path))) signal(-pid, "SIGKILL");
  return true;
}

/** The bytes under a folder, read one entry at a time so the walk never crowds the thread pool. */
async function sizeOf(path: string): Promise<number> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isDirectory()) return stat?.size ?? 0;
  let total = 0;
  for (const entry of await readdir(path).catch(() => [])) total += await sizeOf(join(path, entry));
  return total;
}

async function sweep(options: SweepOptions): Promise<SweepResult> {
  const dir = options.dir ?? tmpdir();
  const now = options.now ?? Date.now();
  const stale: string[] = [];
  const locked: { path: string; pid: number }[] = [];
  const unlocked: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) continue;
      const pid = lockPid(path);
      if (pid === undefined) {
        if (now - stat.mtimeMs > UNLOCKED_MS && chromeWrote(path)) unlocked.push(path);
      } else if (!alive(pid)) stale.push(path);
      else if (KOS_CHROMES.some((prefix) => name.startsWith(prefix))) locked.push({ path, pid });
    } catch {
      // Gone already.
    }
  }

  const stopped: number[] = [];
  if (locked.length || unlocked.length) {
    // What is running decides the rest; unknown is kept.
    const processes = options.processes ?? processTable;
    const running = await processes();
    if (running) {
      for (const { path, pid } of locked) {
        const proc = running.find((p) => p.pid === pid);
        if (!proc || proc.ppid !== 1 || !namesProfile(proc.args, path)) continue;
        if (!(await stopOrphan(path, pid, processes))) continue;
        stopped.push(pid);
        stale.push(path);
      }
      stale.push(...unlocked.filter((path) => !running.some((p) => namesProfile(p.args, path))));
    }
  }

  const result: SweepResult = { removed: [], freed: 0, failed: [], stopped };
  const queue = [...stale];
  const worker = async (): Promise<void> => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      const bytes = await sizeOf(path);
      try {
        await rm(path, RM);
        result.removed.push(path);
        result.freed += bytes;
      } catch (err) {
        result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: DELETES_AT_ONCE }, worker));
  return result;
}

/** The sweep running in each folder. */
const inFlight = new Map<string, Promise<SweepResult>>();

/** Sweep the left-behind profiles. One sweep of a folder at a time: a call while one runs there gets that one. */
export function sweepProfiles(options: SweepOptions = {}): Promise<SweepResult> {
  const dir = options.dir ?? tmpdir();
  let running = inFlight.get(dir);
  if (!running) {
    running = sweep({ ...options, dir }).finally(() => inFlight.delete(dir));
    inFlight.set(dir, running);
  }
  return running;
}
