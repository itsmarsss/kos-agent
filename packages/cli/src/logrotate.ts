import { copyFileSync, existsSync, fstatSync, ftruncateSync, renameSync, statSync } from "node:fs";

/** Past this, daemon.log is rotated. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** How many rotated logs are kept beside it (daemon.log.1 newest). */
export const LOG_KEEP = 3;

export interface RotateOptions {
  /** The descriptor the host writes its log through (stdout). */
  fd?: number;
  maxBytes?: number;
  keep?: number;
}

/**
 * Rotate the log this process writes to, when it is the file at `path` and
 * has grown past the limit. The descriptor is held by whoever started the
 * host (the detached start, or launchd's StandardOutPath), so the file is
 * copied out and the descriptor truncated in place: opened for append, the
 * next write lands at the new end. A line written during the copy can be lost.
 */
export function rotateOwnLog(path: string, options: RotateOptions = {}): boolean {
  const fd = options.fd ?? 1;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const keep = options.keep ?? LOG_KEEP;
  let own: ReturnType<typeof fstatSync>;
  try {
    own = fstatSync(fd);
    const file = statSync(path);
    if (!own.isFile() || own.ino !== file.ino || own.dev !== file.dev) return false;
  } catch {
    return false;
  }
  if (own.size <= maxBytes) return false;
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  }
  copyFileSync(path, `${path}.1`);
  ftruncateSync(fd, 0);
  return true;
}
