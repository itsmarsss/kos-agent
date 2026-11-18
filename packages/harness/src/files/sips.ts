import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageType } from "./headers.js";
import type { Converter, ModelImageType, OpenPicture } from "./images.js";
import { pixels } from "./pixels.js";

/**
 * Pictures read and written by macOS's own sips, which every Mac has and
 * which reads everything a camera or a phone makes (HEIC included) without
 * an install or a permission prompt. It works on files, so each picture gets
 * a folder of its own in the temp dir, gone when the picture is closed.
 *
 * sips parses what the owner sent, so it runs in a sandbox: no network, and
 * writes only to its own folder and the top of the user's temp folder,
 * where it puts its scratch file. macOS's sandbox-exec asks nothing of the
 * owner. Where it is missing, or fails to apply, sips is not run at all: the
 * picture goes to the pixels worker instead.
 */

const SIPS = "/usr/bin/sips";
const SANDBOX = "/usr/bin/sandbox-exec";
/** A 100 MB TIFF takes a few seconds; a minute is a stuck sips, not a slow one. */
const TIMEOUT_MS = 60_000;

const EXTENSION: Record<ImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
};

/** The user's own temp folder, where sips writes its scratch file whatever TMPDIR says. */
let userTemp: string | undefined;

function userTempDir(): string {
  userTemp ??= realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim());
  return userTemp;
}

const regexOf = (path: string): string => path.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");

/** A sandbox profile that lets sips write only to `dir` and files at the top of the user's temp folder, and reach no network. */
export function sipsProfile(dir: string): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${realpathSync(dir)}") (literal "/dev/null") (regex #"^${regexOf(userTempDir())}/[^/]+$"))`,
  ].join("");
}

/** sandbox-exec could not put sips in its sandbox: nothing of sips ran. */
class SandboxFailed extends Error {}

function run(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SANDBOX, ["-p", sipsProfile(dir), SIPS, ...args], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) resolve(stdout);
      // sandbox-exec speaks for itself when it cannot apply the profile; sips's own errors never start so.
      else if (stderr.startsWith("sandbox-exec:")) reject(new SandboxFailed(stderr.trim()));
      else reject(new Error(`sips: ${stderr.trim() || err.message}`));
    });
  });
}

/** Whether sips can be run sandboxed here: sandbox-exec is there, and has not failed to apply. */
let sandboxWorks = existsSync(SANDBOX);

/** A property sips printed, as "  name: value". */
function property(out: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name}: (.+)$`, "m").exec(out)?.[1]?.trim();
}

export const sips: Converter = {
  async open(bytes: Buffer, type: ImageType, maxPixels: number): Promise<OpenPicture> {
    if (!sandboxWorks) return pixels.open(bytes, type, maxPixels);
    try {
      return await sandboxed(bytes, type, maxPixels);
    } catch (err) {
      if (!(err instanceof SandboxFailed)) throw err;
      console.warn(`[images] sips could not be sandboxed, so pictures are read without it from now on: ${err.message}`);
      sandboxWorks = false;
      return pixels.open(bytes, type, maxPixels);
    }
  },
};

/** The picture opened by sips, in its sandbox. */
async function sandboxed(bytes: Buffer, type: ImageType, maxPixels: number): Promise<OpenPicture> {
  const dir = await mkdtemp(join(tmpdir(), "kos-image-"));
  const close = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    const input = join(dir, `in.${EXTENSION[type]}`);
    await writeFile(input, bytes);
    const props = await run(dir, ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", input]);
    const width = Number(property(props, "pixelWidth"));
    const height = Number(property(props, "pixelHeight"));
    // sips names a file it cannot read and carries on, so no size is the refusal.
    if (!(width > 0 && height > 0)) throw new Error(`sips could not read it as ${EXTENSION[type].toUpperCase()}`);
    if (width * height > maxPixels) throw new Error(`it is ${width} by ${height}, past the ${maxPixels / 1_000_000} megapixels KOS reads`);
    return {
      width,
      height,
      alpha: property(props, "hasAlpha") === "yes",
      async encode(to: ModelImageType, edge: number, quality: number): Promise<Buffer> {
        const png = to === "image/png";
        const output = join(dir, png ? "out.png" : "out.jpg");
        await run(dir, [
          "-s", "format", png ? "png" : "jpeg",
          ...(png ? [] : ["-s", "formatOptions", String(quality)]),
          // -Z also makes a smaller picture larger, so it is given only when one must shrink.
          ...(Math.max(width, height) > edge ? ["-Z", String(edge)] : []),
          input, "--out", output,
        ]);
        return readFile(output);
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
