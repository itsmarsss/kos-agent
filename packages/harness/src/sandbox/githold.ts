import { spawnSync } from "node:child_process";

/**
 * Git, held to its own code.
 *
 * A read like `git status` or `git diff` runs without asking, and git reads
 * its config and attributes from the repository it runs in, which the agent
 * can write. Several settings there name a program to run: core.fsmonitor
 * on every status, a textconv or clean filter picked by .gitattributes, a
 * pager, an editor, hooks, a signing program. So every shell command gets
 * them pinned from the environment, at command scope, which beats any
 * repository's config; attributes are read from the empty tree, so no
 * .gitattributes picks a driver. diff.external cannot be unset from the
 * environment, so a repository's config and hooks are not written by a
 * run nobody approved, nor by the file tools: see gitControlPatterns and
 * gitControlRefusal.
 */

/** Settings that each name a program, pinned to one that runs nothing of the agent's. */
const PINNED: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.editor", "true"],
  ["core.attributesFile", "/dev/null"],
  ["sequence.editor", "true"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["log.showSignature", "false"],
  ["gpg.program", "gpg"],
  ["gpg.ssh.program", "ssh-keygen"],
  ["gpg.x509.program", "gpgsm"],
  // A folder laid out as a bare repository is otherwise opened as one, config and all.
  ["safe.bareRepository", "explicit"],
];

/** The empty tree's id: attributes read from it are none. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** True for a `git --version` of 2.40 or later, the first to honour GIT_ATTR_SOURCE. */
export function honoursAttrSource(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 40);
}

let probed: boolean | undefined;

/** Whether the git on this PATH honours GIT_ATTR_SOURCE; asked once. */
function attrSourceHonoured(path: string | undefined): boolean {
  if (probed === undefined) {
    const run = spawnSync("git", ["--version"], { encoding: "utf8", env: { PATH: path ?? "/usr/bin:/bin" } });
    probed = run.status === 0 && honoursAttrSource(run.stdout);
  }
  return probed;
}

/**
 * The environment with git's program-running settings pinned, after any of
 * its own GIT_CONFIG_* entries so these are read last and win.
 */
export function gitHoldEnv(env: Record<string, string>, attrSource = attrSourceHonoured(env.PATH)): Record<string, string> {
  const out = { ...env };
  const own = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const start = Number.isInteger(own) && own > 0 ? own : 0;
  PINNED.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(start + PINNED.length);
  if (attrSource) out.GIT_ATTR_SOURCE = EMPTY_TREE;
  out.GIT_EDITOR = "true";
  out.GIT_SEQUENCE_EDITOR = "true";
  out.GIT_PAGER = "cat";
  out.PAGER = "cat";
  return out;
}

/**
 * Sandbox regexes for what of git's control an unapproved shell run may not write: any
 * repository's config, hooks and info/attributes, and the global config
 * under the child's home, which is the workspace.
 */
export function gitControlPatterns(home: string): string[] {
  const at = home.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
  return [
    "/\\.git/(config|info/attributes)$",
    "/\\.git/hooks(/|$)",
    `^(/private)?${at}/\\.gitconfig$`,
    `^(/private)?${at}/\\.config/git(/|$)`,
  ];
}

/**
 * Why the file tools may not write or move `rel`, a workspace-relative path
 * as foldedPath gives it: anything inside a .git, a .git itself (a file
 * there could point git at a folder of the agent's), or git's global
 * config under the workspace, which is the home every child is given.
 */
export function gitControlRefusal(rel: string): string | undefined {
  const parts = rel.toLowerCase().split("/");
  const global = parts[0] === ".gitconfig" || (parts[0] === ".config" && parts[1] === "git");
  if (!parts.includes(".git") && !global) return undefined;
  return `${rel} is git's own control (config, hooks, attributes), which can name programs to run; files.* does not change it. Use git itself through shell.run, which asks the owner`;
}
