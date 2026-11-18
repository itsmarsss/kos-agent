import { runRequest, type ConvertRequest } from "./convert.js";

/**
 * The viewer's child process: one file converted, its answer sent, and gone.
 * It runs apart from KOS because a parser fed a hostile file can loop or
 * allocate without end, which nothing in the same process can stop; here
 * run.ts ends it on a clock, or when its resident memory passes a ceiling
 * (buffers included, which a heap limit alone does not count).
 */

if (process.send) {
  process.once("message", (req: ConvertRequest) => {
    let reply: unknown;
    try {
      reply = { ok: true, view: runRequest(req) };
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    process.send!(reply, () => process.exit(0));
  });
}
