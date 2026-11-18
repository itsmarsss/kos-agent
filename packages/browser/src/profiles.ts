import { execFile } from "node:child_process";
import { readdirSync, readlinkSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway Chrome profiles left in the temp folder.
 *
 * Every Chrome KOS starts for a moment (a check, an export, a test) gets a
 * kos-* folder in the temp folder and deletes it once that Chrome exits. A
 * host that stopped before its Chrome did leaves the folder behind, and a
 * Chrome profile is many files. The sweep finds them: a profile whose lock
 * names a process that is gone, or an unlocked one a day old that no running
 * process names as its profile. A folder whose Chrome is running, and
 * anything not named kos-*, is never touched.
 */

const PREFIX = "kos-";
/** How old an unlocked folder must be before it is taken for left behind. */
const UNLOCKED_MS = 24 * 60 * 60 * 1000;

/** Whether a process is running: signal 0 checks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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

/** Every running process's command line, or undefined when they cannot be read. */
const commandLines = (): Promise<string[] | undefined> =>
  new Promise((resolve) => {
    execFile("ps", ["-axww", "-o", "args="], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? undefined : out.split("\n")));
  });

export interface SweepOptions {
  /** The folder to sweep. The system's temp folder by default. */
  dir?: string;
  now?: number;
  /** Test seam: the running processes' command lines. */
  processes?: () => Promise<string[] | undefined>;
}

/** Remove the left-behind profiles. Returns the paths removed. */
export async function sweepProfiles(options: SweepOptions = {}): Promise<string[]> {
  const dir = options.dir ?? tmpdir();
  const now = options.now ?? Date.now();
  const stale: string[] = [];
  const unlocked: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
      const pid = lockPid(path);
      if (pid !== undefined) {
        if (!alive(pid)) stale.push(path);
      } else if (now - statSync(path).mtimeMs > UNLOCKED_MS) {
        unlocked.push(path);
      }
    } catch {
      // Gone already.
    }
  }
  if (unlocked.length) {
    // An old folder with no lock may still be some Chrome's: one that names it is running. Unknown is kept.
    const running = await (options.processes ?? commandLines)();
    if (running) stale.push(...unlocked.filter((path) => !running.some((line) => line.includes(`--user-data-dir=${path}`))));
  }
  // Off the event loop: a backlog can be many thousands of files.
  const removed = await Promise.all(stale.map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).then(() => path, () => undefined)));
  return removed.filter((path): path is string => path !== undefined);
}
