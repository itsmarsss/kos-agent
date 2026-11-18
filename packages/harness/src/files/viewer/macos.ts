import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { limited } from "./run.js";

/**
 * What macOS reads that KOS does not: an old Word file, RTF and OpenDocument
 * text through textutil, and a picture of almost any document through
 * QuickLook's qlmanage. Both ship with every Mac and ask the owner nothing.
 *
 * textutil parses the file in its own process, so it runs in a sandbox that
 * reaches no network and writes nothing (its HTML comes back on stdout).
 * Where the sandbox cannot be applied it is not run at all. qlmanage refuses
 * to start inside a second sandbox, and needs none: it hands the file to
 * QuickLook's generators, which macOS already runs sandboxed and apart; so
 * it is used only for the first slide of an old deck (.ppt, .odp). Each
 * file is copied into a fresh temp folder first and the folder removed
 * after, so neither tool is ever pointed into the workspace.
 */

const TEXTUTIL = "/usr/bin/textutil";
const QLMANAGE = "/usr/bin/qlmanage";
const SANDBOX = "/usr/bin/sandbox-exec";
export const TOOL_TIMEOUT_MS = 20_000;
/** A thumbnail is a glance: QuickLook given a file it cannot read can sit on it, and a gallery waits behind it. */
const THUMB_TIMEOUT_MS = 8_000;
const HTML_MAX = 32 * 1024 * 1024;

const quoted = (path: string): string => `"${path.replace(/["\\]/g, "\\$&")}"`;

/**
 * textutil's sandbox: no network, no writes, nothing read from anyone's
 * files but the one copy it was given (system paths stay readable, as it
 * needs its frameworks and fonts), and nothing run but itself.
 */
export function textutilProfile(dir: string): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
    `(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath ${quoted(realpathSync(homedir()))}))`,
    `(allow file-read* (subpath ${quoted(realpathSync(dir))}))`,
    "(deny process-exec)",
    `(allow process-exec (literal ${quoted(TEXTUTIL)}))`,
  ].join("");
}

export function hasTextutil(): boolean {
  return process.platform === "darwin" && existsSync(TEXTUTIL) && existsSync(SANDBOX);
}

export function hasQuickLook(): boolean {
  return process.platform === "darwin" && existsSync(QLMANAGE);
}

function run(file: string, args: string[], maxBuffer: number, timeout = TOOL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (!err) resolve(stdout);
      else if ((err as { killed?: boolean }).killed) reject(new Error(`it took more than ${timeout / 1000} s to read, so it was stopped`));
      else reject(new Error(stderr.trim().split("\n")[0] || err.message));
    });
  });
}

/** A file in a temp folder of its own, under a plain name with its extension, for the tool to read. */
async function staged<T>(bytes: Uint8Array, ext: string, use: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kos-view-"));
  try {
    const file = join(dir, `file.${ext}`);
    await writeFile(file, bytes);
    return await use(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A .doc, .rtf or .odt as HTML, by textutil in its sandbox; to be cleaned before anyone sees it. */
export function textutilHtml(bytes: Uint8Array, ext: string): Promise<string> {
  return staged(bytes, ext, (file, dir) => run(SANDBOX, ["-p", textutilProfile(dir), TEXTUTIL, "-convert", "html", "-stdout", "-noload", "-nostore", file], HTML_MAX));
}

/** A PNG of the file's first page or frame, its long side `edge`, by QuickLook; undefined when it draws none. */
export function quickLookPng(bytes: Uint8Array, ext: string, edge: number): Promise<Buffer | undefined> {
  return staged(bytes, ext, async (file, dir) => {
    await run(QLMANAGE, ["-t", "-s", String(edge), "-o", dir, file], 1024 * 1024, THUMB_TIMEOUT_MS);
    const png = join(dir, `file.${ext}.png`);
    return existsSync(png) ? readFile(png) : undefined;
  });
}

/** QuickLook as KOS uses it, thumbnails and first slides alike: two files at a time, the rest waiting. */
export const sharedQuickLook = hasQuickLook() ? limited(2, quickLookPng) : undefined;
