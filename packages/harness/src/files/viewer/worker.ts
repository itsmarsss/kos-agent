import { parentPort, workerData } from "node:worker_threads";

import { runRequest, type ConvertRequest } from "./convert.js";

/**
 * The viewer's worker: one file converted, then ended. It runs apart from
 * KOS because a parser fed a hostile file can loop or allocate without end,
 * which nothing in the same thread can stop; here the main thread ends it on
 * a timeout, and its heap has a ceiling (run.ts).
 */

export const VIEWER_WORKER = "kos-viewer";

if (workerData === VIEWER_WORKER && parentPort) {
  const port = parentPort;
  port.once("message", (req: ConvertRequest) => {
    try {
      port.postMessage({ ok: true, view: runRequest(req) });
    } catch (err) {
      port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
