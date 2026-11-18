import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { pictureSize, type ImageType } from "./headers.js";
import type { Converter, ModelImageType, OpenPicture } from "./images.js";
import type { PixelsReply, PixelsRequest } from "./pixelsworker.js";

/** What tells pixelsworker.ts it was started to answer; it cannot import this, as it imports nothing of KOS's but types. */
const PIXELS_WORKER = "kos-pixels";

/**
 * Pictures read and written in JavaScript and WebAssembly, for a host with
 * no sips: Linux, and the container KOS runs in. Nothing here is a native
 * build, so it installs wherever Node does.
 *
 * Each picture is read in a worker of its own, ended when the picture is
 * done with: a decoder fed a hostile file can loop or allocate without end,
 * which no try in the same thread catches, and a worker's end also frees
 * everything its WebAssembly decoders held. A worker past its memory or its
 * time is ended, and the picture refused with why.
 */

/**
 * The JavaScript heap a picture's worker may use: what pngjs, jpeg-js and the
 * rest build as they decode. Pixel buffers and WebAssembly memory live
 * outside the heap and are not bounded by it; they are bounded by the 50
 * megapixel cap, checked from the header before decoding.
 */
export const WORKER_HEAP_MB = 1024;
/** How long one step (a read, or a write at one size) may take; a 50 megapixel TIFF reads in a few seconds. */
export const WORKER_STEP_MS = 30_000;

/**
 * The worker's code: built beside this file, or, run from source (the
 * tests), the TypeScript itself, which Node runs with its types stripped.
 */
function workerUrl(): URL {
  const built = new URL("./pixelsworker.js", import.meta.url);
  return existsSync(fileURLToPath(built)) ? built : new URL("./pixelsworker.ts", import.meta.url);
}

/** A worker for one picture, asked one thing at a time, and ended on a timeout, a crash or a refusal. */
class PictureWorker {
  private readonly worker = new Worker(workerUrl(), { workerData: PIXELS_WORKER, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB }, stdout: true, stderr: true });
  private ended = false;

  constructor(private readonly stepMs: number) {
    // Always heard, between asks too: a worker's error with nobody listening would take KOS down with it.
    this.worker.on("error", () => {
      this.ended = true;
    });
  }

  ask(request: PixelsRequest, transfer: ArrayBuffer[] = []): Promise<Exclude<PixelsReply, { ok: false }>> {
    if (this.ended) return Promise.reject(new Error("the picture's reader has ended"));
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.worker.off("message", onMessage).off("error", onError).off("exit", onExit);
      };
      const fail = (why: string): void => {
        done();
        void this.end();
        reject(new Error(why));
      };
      const onMessage = (reply: PixelsReply): void => {
        if (reply.ok) {
          done();
          resolve(reply);
        } else fail(reply.error);
      };
      // Out of memory, or a stack the decoder blew: the worker dies, and says so here.
      const onError = (err: Error): void => fail(`its decoder failed: ${err.message}`);
      const onExit = (): void => fail("its decoder stopped");
      const timer = setTimeout(() => fail(`it took more than ${this.stepMs / 1000} s to read`), this.stepMs);
      this.worker.on("message", onMessage).on("error", onError).on("exit", onExit);
      this.worker.postMessage(request, transfer);
    });
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.worker.terminate();
  }
}

/** A converter whose workers each have `stepMs` for a step; the default is WORKER_STEP_MS. */
export function pixelsConverter(stepMs = WORKER_STEP_MS): Converter {
  return {
    async open(bytes: Buffer, type: ImageType, maxPixels: number): Promise<OpenPicture> {
      const worker = new PictureWorker(stepMs);
      try {
        // A copy is handed over, so the caller keeps its own bytes.
        const copy = new Uint8Array(bytes);
        // The size its header gives, for the decoders that size nothing before they allocate.
        const size = type === "image/webp" || type === "image/avif" ? pictureSize(bytes, type) : undefined;
        const read = await worker.ask({ op: "open", bytes: copy, type, maxPixels, ...(size ? { size } : {}) }, [copy.buffer]);
        if (!("width" in read)) throw new Error("its decoder said nothing of its size");
        return {
          width: read.width,
          height: read.height,
          alpha: read.alpha,
          async encode(to: ModelImageType, edge: number, quality: number): Promise<Buffer> {
            const written = await worker.ask({ op: "encode", to, edge, quality });
            if (!("data" in written)) throw new Error("its encoder wrote nothing");
            return Buffer.from(written.data.buffer, written.data.byteOffset, written.data.byteLength);
          },
          close: () => worker.end(),
        };
      } catch (err) {
        await worker.end();
        throw err;
      }
    },
  };
}

export const pixels = pixelsConverter();
