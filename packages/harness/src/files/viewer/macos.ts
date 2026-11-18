import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What macOS reads that KOS does not: an old Word file, RTF and OpenDocument
 * text, through textutil, which ships with every Mac and asks the owner
 * nothing. It parses the file in its own process, so it runs in a sandbox
 * (textutilProfile) and, where the sandbox cannot be applied, not at all.
 * The file is copied into a fresh temp folder first and the folder removed
 * after, so textutil is never pointed into the workspace.
 *
 * QuickLook is not used: qlmanage will not start inside a sandbox, and it
 * would run a document's generator in KOS's own process tree.
 */

const TEXTUTIL = "/usr/bin/textutil";
const SANDBOX = "/usr/bin/sandbox-exec";
export const TOOL_TIMEOUT_MS = 20_000;
const HTML_MAX = 32 * 1024 * 1024;

const quoted = (path: string): string => `"${path.replace(/["\\]/g, "\\$&")}"`;

/**
 * textutil's sandbox: no network, no writes, no Mach services (it converts
 * without any), nothing read from anyone's files or any temp folder but the
 * one copy it was given (system paths stay readable, as it needs its
 * frameworks and fonts), and nothing run but itself.
 */
export function textutilProfile(dir: string): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
    "(deny mach-lookup)",
    `(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath ${quoted(realpathSync(homedir()))}))`,
    `(allow file-read* (subpath ${quoted(realpathSync(dir))}))`,
    "(deny process-exec)",
    `(allow process-exec (literal ${quoted(TEXTUTIL)}))`,
  ].join("");
}

export function hasTextutil(): boolean {
  return process.platform === "darwin" && existsSync(TEXTUTIL) && existsSync(SANDBOX);
}

function run(file: string, args: string[], maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      if (!err) resolve(stdout);
      else if ((err as { killed?: boolean }).killed) reject(new Error(`it took more than ${TOOL_TIMEOUT_MS / 1000} s to read, so it was stopped`));
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
