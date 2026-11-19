import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { realOf, vaultDir } from "../secrets/vault.js";
import { bubblewrap, bwrapCommand } from "./bwrap.js";
import type { JailNat } from "./jailrun.js";

/**
 * How a shell command is kept inside the workspace.
 *
 * resolvePath() is the perimeter for every tool the harness writes, but a
 * shell is the owner's whole machine unless something outside the process
 * says otherwise. In the container the container says so. On the owner's
 * Mac, where iMessage keeps the host out of the container, the kernel's
 * own sandbox does: the command may read the system and write the
 * workspace, and the owner's home directory, where the keys, the mail and
 * this project's .env live, is not there at all. On bare Linux bubblewrap
 * does the same with namespaces and bind mounts (see bwrap.ts). Anywhere
 * else there is no jail, and the shell is refused rather than run unconfined.
 */

export interface JailOptions {
  workspaceRoot: string;
  /** Home directories whose contents the command must not see. The owner's by default. */
  homes?: string[];
  platform?: NodeJS.Platform;
  /** True when the host itself runs in the container, which is the jail. */
  contained?: boolean;
  /** The bwrap that jails on Linux, or false for none: found and tried once when not given. */
  bubblewrap?: string | false;
  /** The NAT that gives a networked bwrap run its own network, or false for none: found when not given. */
  nat?: JailNat | false;
  /** Where it may write, and read back; the whole workspace by default. */
  writes?: string[];
  /** Under the workspace yet not to be read: KOS's own state, for a program that runs without asking. */
  hidden?: string[];
  /** Under the workspace yet not to be written: KOS's own settings and database, whatever path, glob or link names them; a folder ends in a slash. */
  readOnly?: string[];
  /** Inside a read-only folder yet writable again: KOS's temp and caches under its own state. */
  writableWithin?: string[];
  /** Regexes over absolute paths not to be written, wherever they fall: a repository's config and hooks. */
  unwritable?: string[];
  /** Regexes over absolute paths not to be read, wherever they fall. */
  unreadable?: string[];
  /**
   * True to keep the program from reaching past the sandbox through the
   * system: no signals to other processes, no Apple Events, no preference
   * writes, and only the mach services a plain program needs, so no
   * LaunchServices (`open`), pasteboard or other daemon does its bidding.
   * Under bubblewrap every run is sealed: its own namespaces, no /run.
   */
  sealed?: boolean;
  /** Readable although under a denied home: an interpreter's own libraries. */
  reads?: string[];
  /**
   * False for a program that must not reach the network at all; "local" for
   * one that may reach this machine (a test server it starts) and nothing
   * past it. KOS's own ports are refused either way, and never bound.
   */
  network?: boolean | "local";
  /**
   * KOS's own ports, which no jailed program may connect to, on any address
   * (a v4 address in v6 form included): see `kosPorts`.
   */
  kosPorts?: number[];
  /** Files and folders never read, wherever they are: see `kosSecretFiles`. */
  secretFiles?: string[];
}

/** A port named in the environment, or the default. */
function portIn(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : fallback;
}

/**
 * Every port KOS itself listens on, as this host was started: the API, the
 * sites server after it, the Wi-Fi listener for phones (the API's plus two
 * unless KOS_DEVICE_LAN_PORT says), and KOS's own Chrome's debugging port
 * (9225 unless KOS_BROWSER_PORT says), which drives a browser signed in to
 * whatever KOS browses.
 */
export function kosPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const api = portIn(env.KOS_PORT, 4317);
  return [...new Set([api, api + 1, portIn(env.KOS_DEVICE_LAN_PORT, api + 2), portIn(env.KOS_BROWSER_PORT, 9225)])];
}

/**
 * Files no jailed program may read wherever they are: this boot's write key,
 * KOS's keys under ~/.kos, and the secrets vault's folder (with its key and
 * scrub index) and sequence record wherever KOS_VAULT_DIR puts them.
 */
export function kosSecretFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  // Real, so a vault folder reached through a link is denied where it really is.
  const vault = realOf(vaultDir(env));
  return [...new Set([env.KOS_WRITE_KEY_FILE?.trim(), resolve(homedir(), ".kos"), vault, `${vault}.seq`].filter((p): p is string => !!p))];
}

export interface JailedCommand {
  file: string;
  args: string[];
  /**
   * Undoes what jailing it put in place, once the program has ended (see
   * placeholder.ts), and says what it moved out of the workspace after a
   * run nobody approved (see gitwatch.ts).
   */
  release?: () => string[];
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

/** Each path, both spellings, as subpath filters. */
function subpaths(paths: string[]): string {
  return paths.flatMap(spellings).map((p) => `(subpath ${sb(p)})`).join(" ");
}

/** The mach services a sealed program may look up: name lookup, notifications, logging. */
const SEALED_SERVICES = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.notification_center",
  "com.apple.system.logger",
  "com.apple.logd",
  "com.apple.diagnosticd",
];

const SEALED = [
  "(deny signal (target others))",
  "(deny mach-lookup)",
  `(allow mach-lookup ${SEALED_SERVICES.map((name) => `(global-name ${sb(name)})`).join(" ")})`,
  "(deny appleevent-send)",
  "(deny user-preference-write)",
];

/**
 * The profile: everything allowed, then writes denied except in the
 * workspace (or the folders named), then the home directories denied for
 * reading except the workspace, which may itself be under one, then what is
 * hidden inside the workspace, then the writable folders carved back out of
 * that, then what is read-only inside it. A later rule wins over an earlier one, which is what lets the
 * workspace be carved back out of a denied home. No temp tree is opened up:
 * the child's TMPDIR is inside the workspace, and a program that insists on
 * /tmp fails where it can be seen.
 */
/**
 * The network a jailed program has. Every program is kept off KOS's own
 * ports, to connect to (on any address, a v4 one in v6 form included) and
 * to bind (so it cannot squat on one while KOS restarts). "local" allows
 * this machine and nothing past it, the order mattering: a later rule wins.
 */
function networkRules(network: JailOptions["network"], ports: readonly number[]): string[] {
  const kos = [
    ...ports.map((p) => `(deny network-outbound (remote ip ${sb(`*:${p}`)}))`),
    ...ports.map((p) => `(deny network-bind (local ip ${sb(`*:${p}`)}))`),
  ];
  if (network === false) return ["(deny network*)"];
  if (network === "local") {
    return ["(deny network*)", '(allow network* (remote ip "localhost:*"))', '(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', ...kos];
  }
  return kos;
}

export function sandboxProfile(options: JailOptions): string {
  const homes = options.homes ?? [homedir()];
  const ws = subpaths([options.workspaceRoot]);
  const writes = options.writes ? subpaths(options.writes) : ws;
  const lines = [
    "(version 1)",
    "(allow default)",
    ...networkRules(options.network, options.kosPorts ?? kosPorts()),
    "(deny file-write*)",
    `(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/tty"))`,
    ...homes.map((h) => `(deny file-read* (subpath ${sb(resolve(h))}))`),
    `(allow file-read* ${[ws, ...(options.reads?.length ? [subpaths(options.reads)] : [])].join(" ")})`,
    ...(options.hidden?.length ? [`(deny file-read* ${subpaths(options.hidden)})`] : []),
    ...(options.writes?.length ? [`(allow file-read* ${writes})`] : []),
    ...(options.readOnly?.length ? [`(deny file-write* ${subpaths(options.readOnly)})`] : []),
    ...(options.writableWithin?.length ? [`(allow file-write* ${subpaths(options.writableWithin)})`] : []),
    ...(options.unwritable?.length ? [`(deny file-write* ${options.unwritable.map((r) => `(regex #"${r}")`).join(" ")})`] : []),
    ...(options.unreadable?.length ? [`(deny file-read* ${options.unreadable.map((r) => `(regex #"${r}")`).join(" ")})`] : []),
    // Last, so no allow above carves them back out.
    ...((options.secretFiles ?? kosSecretFiles()).length ? [`(deny file-read* ${subpaths(options.secretFiles ?? kosSecretFiles())})`] : []),
    "(allow file-read-metadata)",
    ...(options.sealed ? SEALED : []),
    "",
  ];
  return lines.join("\n");
}

export function isContained(): boolean {
  return process.env.KOS_CONTAINED === "1" || existsSync("/.dockerenv");
}

/** True where KOS has a jail of its own, not the container's: macOS's sandbox, or a working bubblewrap on Linux. */
export function ownJail(platform: NodeJS.Platform = process.platform, bwrap?: string | false): boolean {
  return platform === "darwin" || (platform === "linux" && !!(bwrap ?? bubblewrap()));
}

/** A program and its arguments, jailed for this platform. */
export function jailedProgram(file: string, args: string[], options: JailOptions): JailedCommand {
  const platform = options.platform ?? process.platform;
  // Bubblewrap where it works, the container included: it narrows what the container allows.
  const bwrap = platform === "linux" ? (options.bubblewrap ?? bubblewrap()) : undefined;
  if (bwrap) return bwrapCommand(bwrap, file, args, { ...options, secretFiles: options.secretFiles ?? kosSecretFiles() });
  // The container is the jail: network, kosPorts and the rest hold nothing here, so shell.run is never Auto's in it.
  if (options.contained ?? isContained()) {
    return { file, args };
  }
  if (platform === "darwin") {
    return { file: "/usr/bin/sandbox-exec", args: ["-p", sandboxProfile(options), file, ...args] };
  }
  throw new Error("this needs a jail: install bubblewrap (bwrap), run the host in the container (docker compose up), or run on macOS");
}

/** The process to spawn for a shell command, jailed for this platform. */
export function jailedCommand(command: string, options: JailOptions): JailedCommand {
  return jailedProgram("/bin/sh", ["-c", command], options);
}
