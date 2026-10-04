import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * How a shell command is kept inside the workspace.
 *
 * resolvePath() is the perimeter for every tool the harness writes, but a
 * shell is the owner's whole machine unless something outside the process
 * says otherwise. In the container the container says so. On the owner's
 * Mac, where iMessage keeps the host out of the container, the kernel's
 * own sandbox does: the command may read the system and write the
 * workspace, and the owner's home directory, where the keys, the mail and
 * this project's .env live, is not there at all. Anywhere else there is
 * no jail, and the shell is refused rather than run unconfined.
 */

export interface JailOptions {
  workspaceRoot: string;
  /** Home directories whose contents the command must not see. The owner's by default. */
  homes?: string[];
  platform?: NodeJS.Platform;
  /** True when the host itself runs in the container, which is the jail. */
  contained?: boolean;
}

export interface JailedCommand {
  file: string;
  args: string[];
}

/** Quote for a sandbox profile string: backslashes and double quotes. */
function sb(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Both spellings of a path on macOS, where /tmp and /var are links into /private. */
function spellings(path: string): string[] {
  const abs = resolve(path);
  return abs.startsWith("/private/") ? [abs, abs.slice("/private".length)] : [abs, `/private${abs}`];
}

/**
 * The profile: everything allowed, then writes denied except in the
 * workspace, then the home directories denied for reading except the
 * workspace, which may itself be under one. A later rule wins over an
 * earlier one, which is what lets the workspace be carved back out of a
 * denied home. No temp tree is opened up: the child's TMPDIR is inside the
 * workspace, and a program that insists on /tmp fails where it can be seen.
 */
export function sandboxProfile(options: JailOptions): string {
  const homes = options.homes ?? [homedir()];
  const ws = spellings(options.workspaceRoot).map(sb).map((p) => `(subpath ${p})`).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${ws} (literal "/dev/null") (regex #"^/dev/tty"))`,
    ...homes.map((h) => `(deny file-read* (subpath ${sb(resolve(h))}))`),
    `(allow file-read* ${ws})`,
    "(allow file-read-metadata)",
    "",
  ];
  return lines.join("\n");
}

export function isContained(): boolean {
  return process.env.KOS_CONTAINED === "1" || existsSync("/.dockerenv");
}

/** A program and its arguments, jailed for this platform. */
export function jailedProgram(file: string, args: string[], options: JailOptions): JailedCommand {
  const platform = options.platform ?? process.platform;
  if (options.contained ?? isContained()) {
    return { file, args };
  }
  if (platform === "darwin") {
    return { file: "/usr/bin/sandbox-exec", args: ["-p", sandboxProfile(options), file, ...args] };
  }
  throw new Error("this needs a jail: run the host in the container (docker compose up), or on macOS");
}

/** The process to spawn for a shell command, jailed for this platform. */
export function jailedCommand(command: string, options: JailOptions): JailedCommand {
  return jailedProgram("/bin/sh", ["-c", command], options);
}
