import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";

/**
 * The vault's files on disk: read only when they are KOS's own and private,
 * written so a crash leaves the old file or the new one, and erased by
 * overwriting before unlinking.
 *
 * Durability: every file is fsynced before its rename and the directory
 * after it. Node has no F_FULLFSYNC, so on macOS a power cut can still lose
 * a write the disk had cached; the rename keeps it all-old or all-new.
 */

export class VaultFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultFsError";
  }
}

const ownUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Why a stat is not private to this user, if it is not. */
function exposure(path: string, st: { mode: number; uid: number }): string | undefined {
  const uid = ownUid();
  if (uid !== undefined && st.uid !== uid) return `${path} belongs to another user`;
  if ((st.mode & 0o077) !== 0) return `${path} can be read by others (mode ${(st.mode & 0o777).toString(8)}): chmod ${st.mode & 0o040000 ? "700" : "600"} it`;
  return undefined;
}

/** The vault's directory, refused when it is a link, another user's, or open to the group or the world. */
export function checkDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new VaultFsError(`${dir} is not a plain directory`);
  const why = exposure(dir, st);
  if (why) throw new VaultFsError(why);
}

/** A private file's text, opened without following a link and checked on the descriptor it was read from. */
export function readPrivate(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new VaultFsError(`${path} is a link; KOS reads only the file itself`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new VaultFsError(`${path} is not a file`);
    const why = exposure(path, st);
    if (why) throw new VaultFsError(why);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every filesystem lets a directory be synced; the rename is still atomic.
  }
}

/**
 * Write `data` so the file is either all old or all new: a temp file made
 * fresh (never one already there, never through a link), fsynced, renamed
 * over, then the directory synced.
 */
export function writeAtomic(path: string, data: string | Buffer, dir: string): void {
  const tmp = `${path}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

/** A synced copy of `from` at `to`, put in place by rename. */
export function copyAtomic(from: string, to: string, dir: string): void {
  const tmp = `${to}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  copyFileSync(from, tmp, constants.COPYFILE_EXCL);
  syncFile(tmp);
  renameSync(tmp, to);
  fsyncDir(dir);
}

/**
 * Overwrite a file with random bytes, sync it, then unlink it. On APFS and
 * on an SSD the old blocks may survive the overwrite (copy-on-write, wear
 * levelling): what makes the erase hold is that the keys are gone.
 */
export function shred(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  try {
    if (st.isFile()) {
      const size = Math.max(statSync(path).size, 32);
      const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        writeSync(fd, randomBytes(size), 0, size, 0);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    unlinkSync(path);
  }
}

/** Keep a file out of Time Machine, by the attribute tmutil sets; no tmutil, so no prompt. */
export function excludeFromBackup(path: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("xattr", ["-w", "com.apple.metadata:com_apple_backup_excludeItem", "com.apple.backupd", path], { stdio: "ignore", timeout: 5_000 });
  } catch {
    // Best effort: the key alone opens nothing without the vault, which is never in the workspace.
  }
}

const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a process that stopped mid-write. */
const LOCK_STALE_MS = 30_000;

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Hold `path` while `run` reads the vault and writes it back, so the host
 * and the CLI never interleave a change. A lock whose process is gone, or
 * that is too old, is taken over.
 */
export function withFileLock<T>(path: string, run: () => T, now: () => number = Date.now): T {
  const until = now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let stale = false;
      try {
        const pid = Number(readFileSync(path, "utf8").trim());
        stale = !Number.isInteger(pid) || pid <= 0 || !alive(pid) || now() - statSync(path).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          unlinkSync(path);
        } catch {
          // Another waiter took it over first.
        }
        continue;
      }
      if (now() > until) throw new VaultFsError("another KOS process is changing the vault; try again in a moment");
      pause(20);
    }
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return run();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Gone already.
    }
  }
}
