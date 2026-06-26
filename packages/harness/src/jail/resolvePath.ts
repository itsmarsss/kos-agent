import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Thrown whenever a path escapes, or attempts to escape, the workspace jail.
 * Carries the offending input so the audit log can record what was attempted.
 */
export class JailError extends Error {
  readonly requested: string;

  constructor(message: string, requested: string) {
    super(message);
    this.name = "JailError";
    this.requested = requested;
  }
}

/**
 * The single jail gate. Every filesystem, sql, and shell path in KOS resolves
 * through this function. It returns an absolute path that is provably inside
 * the workspace root, or throws a JailError.
 *
 * Rejected: `..` traversal, absolute paths that land outside the root, NUL
 * bytes, and any existing path component that is a symlink (a symlink is a
 * potential escape, so the gate refuses all of them rather than trust the
 * target).
 *
 * `root` must be an absolute, real (symlink-free) path. The Workspace resolves
 * the real root once at construction and passes it here.
 */
export function resolvePath(root: string, requestPath: string): string {
  if (!isAbsolute(root)) {
    throw new JailError(`jail root must be absolute: ${root}`, requestPath);
  }
  if (requestPath.includes("\0") || root.includes("\0")) {
    throw new JailError("path contains NUL byte", requestPath);
  }

  // Reject any explicit parent-traversal segment up front. Internal `..` that
  // would normalize back inside the root is still refused: simpler contract,
  // no clever escapes.
  const rawSegments = requestPath.split(/[/\\]/);
  if (rawSegments.includes("..")) {
    throw new JailError(`path traversal rejected: ${requestPath}`, requestPath);
  }

  const candidate = isAbsolute(requestPath)
    ? resolve(requestPath)
    : resolve(root, requestPath);

  // Containment: the candidate must be the root itself or strictly beneath it.
  const rel = relative(root, candidate);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new JailError(`path escapes workspace: ${requestPath}`, requestPath);
  }

  // Symlink check: walk every existing component from the root down. A symlink
  // anywhere along the path is refused. Components that do not exist yet (a
  // file about to be written, a dir about to be made) cannot be symlinks.
  if (rel !== "") {
    const parts = rel.split(sep);
    let current = root;
    for (const part of parts) {
      current = resolve(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch {
        break; // does not exist yet; nothing below it can either
      }
      if (stat.isSymbolicLink()) {
        throw new JailError(
          `symlink rejected in path: ${requestPath}`,
          requestPath,
        );
      }
    }
  }

  return candidate;
}
