import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Converter, ImageType, ModelImageType, OpenPicture } from "./images.js";

/**
 * Pictures read and written by macOS's own sips, which every Mac has and
 * which reads everything a camera or a phone makes (HEIC included) without
 * an install or a permission prompt. It works on files, so each picture gets
 * a folder of its own in the temp dir, gone when the picture is closed.
 */

const SIPS = "/usr/bin/sips";
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

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SIPS, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`sips: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

/** A property sips printed, as "  name: value". */
function property(out: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name}: (.+)$`, "m").exec(out)?.[1]?.trim();
}

export const sips: Converter = {
  async open(bytes: Buffer, type: ImageType): Promise<OpenPicture> {
    const dir = await mkdtemp(join(tmpdir(), "kos-image-"));
    const close = (): Promise<void> => rm(dir, { recursive: true, force: true });
    try {
      const input = join(dir, `in.${EXTENSION[type]}`);
      await writeFile(input, bytes);
      const props = await run(["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", input]);
      const width = Number(property(props, "pixelWidth"));
      const height = Number(property(props, "pixelHeight"));
      // sips names a file it cannot read and carries on, so no size is the refusal.
      if (!(width > 0 && height > 0)) throw new Error(`sips could not read it as ${EXTENSION[type].toUpperCase()}`);
      return {
        width,
        height,
        alpha: property(props, "hasAlpha") === "yes",
        async encode(to: ModelImageType, edge: number, quality: number): Promise<Buffer> {
          const png = to === "image/png";
          const output = join(dir, png ? "out.png" : "out.jpg");
          await run([
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
  },
};
