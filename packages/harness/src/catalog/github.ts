/**
 * GitHub URLs and shorthands, as the owner types or pastes them.
 *
 * On their own so the installer and the catalogue can both read them
 * without importing each other.
 */

/** The parts of a `https://github.com/owner/repo/tree/ref/path` URL. */
export interface GithubTree {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

/**
 * A GitHub URL that names a folder inside a repository, if it does.
 *
 * A plain repository URL is not one: that is a whole repository, which the
 * installer clones as it is. Only `/tree/<ref>/<path>` is a subfolder.
 */
export function parseGithubTree(source: string): GithubTree | undefined {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/tree\/([^/\s]+)\/(.+?)\/?$/.exec(source.trim());
  if (!m) return undefined;
  const [, owner, repo, ref, path] = m;
  if (!owner || !repo || !ref || !path || path.split("/").includes("..")) return undefined;
  return { owner, repo, ref, path };
}

/** `owner/repo` or `owner/repo/some/path`, as typed by the owner. */
export function parseSourceShorthand(text: string): { repo: string; path: string } | undefined {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/(.+?))?\/?$/.exec(text.trim());
  if (!m || !m[1]) return undefined;
  const path = (m[2] ?? "").trim();
  if (path.split("/").includes("..")) return undefined;
  return { repo: m[1], path };
}
