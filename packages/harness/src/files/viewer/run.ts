import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { runRequest, type ConvertRequest } from "./convert.js";
import type { OfficeView } from "@kos/shared";
import { VIEWER_WORKER } from "./worker.js";

/**
 * A conversion run bounded: in a worker of its own with a heap ceiling and
 * a clock, ended on either. Typed arrays and SheetJS's buffers live partly
 * outside the heap, so the input caps (viewer.ts) and the zip caps
 * (convert.ts) bound those; the clock bounds the rest.
 */

export const WORKER_HEAP_MB = 512;
export const WORKER_TIMEOUT_MS = 20_000;

export type Runner = (req: ConvertRequest) => Promise<OfficeView>;

/** A worker to run one request in; made per request, so nothing a file did outlives it. */
export type WorkerFactory = () => Worker;

/** The built worker beside this file; absent when KOS runs from source (the tests), where the runner works in-process. */
function builtWorker(): URL | undefined {
  const url = new URL("./worker.js", import.meta.url);
  return existsSync(fileURLToPath(url)) ? url : undefined;
}

export function workerRunner(make: WorkerFactory, timeoutMs = WORKER_TIMEOUT_MS): Runner {
  return (req) =>
    new Promise((resolve, reject) => {
      const worker = make();
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`it took more than ${timeoutMs / 1000} s to read, so it was stopped`))), timeoutMs);
      worker.on("message", (reply: { ok: true; view: OfficeView } | { ok: false; error: string }) => finish(() => (reply.ok ? resolve(reply.view) : reject(new Error(reply.error)))));
      // Past its heap, or a stack a parser blew: the worker dies and says so here.
      worker.on("error", (err) => finish(() => reject(new Error(`it could not be read: ${err.message}`))));
      worker.on("exit", () => finish(() => reject(new Error("its reader stopped before it finished"))));
      worker.postMessage(req);
    });
}

/** The runner KOS uses: the built worker, or in-process when run from source. */
export function defaultRunner(): Runner {
  const url = builtWorker();
  if (!url) return async (req) => runRequest(req);
  return workerRunner(() => new Worker(url, { workerData: VIEWER_WORKER, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 64 }, stdout: true, stderr: true }));
}
