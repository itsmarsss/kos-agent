import { runJob, type ChildRequest } from "./jobs.js";

/**
 * The viewer's child process: one job done, its answer sent, and gone. It
 * runs apart from KOS because a parser fed a hostile file can loop or
 * allocate without end, which nothing in the same process can stop; run.ts
 * ends it on a clock, a CPU limit the kernel keeps, or when its resident
 * memory passes a ceiling. It also goes the moment KOS does.
 */

if (process.send) {
  process.once("disconnect", () => process.exit(0));
  process.once("message", (req: ChildRequest) => {
    let reply: unknown;
    try {
      reply = { ok: true, value: runJob(req) };
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    process.send!(reply, () => process.exit(0));
  });
}
