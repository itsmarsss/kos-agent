import { spawnSync } from "node:child_process";

import { findProgram } from "./env.js";

/**
 * Git, held to its own code.
 *
 * Git reads config and attributes from the repository it runs in, which
 * the agent can write, and several settings there name a program to run:
 * core.fsmonitor on every status, a textconv or clean filter picked by
 * .gitattributes, a pager, an editor, a signing program, hooks. Every
 * shell command gets them pinned from the environment, at command scope,
 * which beats any repository's config, and reads attributes from the
 * empty tree, so no .gitattributes picks a driver. A run nobody approved
 * (a line judged read-only) also gets no hooks, no transport and no lazy
 * fetch; an approved one keeps the repository's hooks, which the owner
 * approved with the commit.
 *
 * Not pinned: diff.external. Set empty, git tries to run "" and every
 * `git diff` fails; it cannot be unset. A read-only line's `git diff` is
 * run with --no-ext-diff instead (risk/readonly.ts readOnlyLine), and the
 * file tools never write a repository's config (gitControlRefusal).
 */

/** Settings that each name a program, pinned to one that runs nothing of the agent's. */
const PINNED: ReadonlyArray<readonly [string, string]> = [
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

/** Pinned too for a run nobody approved: the repository's hooks. */
const HELD: ReadonlyArray<readonly [string, string]> = [["core.hooksPath", "/dev/null"]];

/** The empty tree's id: attributes read from it are none. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * True for a `git --version` of 2.40 or later: GIT_CONFIG_COUNT came in
 * 2.31 and GIT_ATTR_SOURCE in 2.40, and without both git is not held.
 */
export function gitHoldable(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 40);
}

const probed = new Map<string, boolean>();

/** Whether the git first on this PATH can be held; asked once per PATH. */
export function gitHeldOn(path: string): boolean {
  let held = probed.get(path);
  if (held === undefined) {
    const git = findProgram("git", path);
    const run = git ? spawnSync(git, ["--version"], { encoding: "utf8", env: { PATH: path }, timeout: 5000 }) : undefined;
    held = run?.status === 0 && gitHoldable(run.stdout);
    probed.set(path, held);
  }
  return held;
}

export interface GitHoldOptions {
  /** A run nobody approved: no hooks, no transport, no lazy fetch. */
  readOnly?: boolean;
  /** Whether the git on the PATH honours GIT_ATTR_SOURCE; probed when not given. */
  attrSource?: boolean;
}

/**
 * The environment with git's program-running settings pinned, after any of
 * its own GIT_CONFIG_* entries so these are read last and win.
 */
export function gitHoldEnv(env: Record<string, string>, options: GitHoldOptions = {}): Record<string, string> {
  const out = { ...env };
  const pins = options.readOnly ? [...PINNED, ...HELD] : PINNED;
  const own = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const start = Number.isInteger(own) && own > 0 ? own : 0;
  pins.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(start + pins.length);
  if (options.attrSource ?? gitHeldOn(env.PATH ?? "")) out.GIT_ATTR_SOURCE = EMPTY_TREE;
  out.GIT_EDITOR = "true";
  out.GIT_SEQUENCE_EDITOR = "true";
  out.GIT_PAGER = "cat";
  out.PAGER = "cat";
  if (options.readOnly) {
    out.GIT_ALLOW_PROTOCOL = "";
    out.GIT_NO_LAZY_FETCH = "1";
  }
  return out;
}

/** Sandbox regex for a repository's info/attributes, which a read-only run does not read. */
export const GIT_INFO_ATTRIBUTES = "/\\.git/info/attributes$";

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
