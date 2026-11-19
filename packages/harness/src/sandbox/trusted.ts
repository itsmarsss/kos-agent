import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A system program KOS will run to build a jail: bwrap, pasta, slirp4netns,
 * prlimit. Only one that root owns and nobody else can replace, in a folder
 * likewise held all the way up to /; never a PATH's, which the agent or
 * another user could put a program on.
 */

function rootHeld(path: string): boolean {
  try {
    const s = lstatSync(path);
    return s.uid === 0 && (s.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** True when the program and every folder above it are root's and written by no one else. */
export function trustedProgram(path: string): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  const s = lstatSync(real);
  if (!s.isFile() || (s.mode & 0o111) === 0 || !rootHeld(real)) return false;
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (!rootHeld(dir)) return false;
    if (dir === "/") return true;
  }
}

/** The first trusted program of that name in the system's own folders, /usr/bin first. */
export function findTrusted(name: string): string | undefined {
  return ["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin", "/sbin"].map((dir) => `${dir}/${name}`).find(trustedProgram);
}
