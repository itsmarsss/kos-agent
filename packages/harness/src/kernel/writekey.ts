import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * This boot's write key, kept where a terminal on this machine can read it.
 *
 * The dashboard reads the key from the page KOS serves; the kos CLI, a dev
 * server's proxy and a test script read it from this file, which only the
 * owner may read (0600), outside the workspace, and which every jailed
 * program is denied. One file per port, so a second KOS on the machine (a
 * scratch host) never overwrites the first one's.
 */
export function writeKeyPath(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const given = env.KOS_WRITE_KEY_FILE?.trim();
  return given || join(homedir(), ".kos", port === 4317 ? "write.key" : `write-${port}.key`);
}

/** Keep the key for this boot: the folder the owner's alone, the file readable by them only. */
export function saveWriteKey(path: string, key: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  // A file left by an older boot keeps its mode on write: set it again.
  chmodSync(path, 0o600);
}

/** The key a running KOS keeps for its port, or undefined when there is none. */
export function readWriteKey(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
