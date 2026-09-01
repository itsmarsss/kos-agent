import { describe, expect, it, vi } from "vitest";

import { BuildRegistry } from "./registry.js";

/**
 * The list of what is running.
 *
 * A build started from a tool call and never mentioned again left the owner
 * with a chat that had gone quiet and no way to tell working from stuck. What
 * matters here is that the states are distinguishable and that a build can be
 * stopped while it is still going.
 */
describe("builds that are running", () => {
  const started = (r: BuildRegistry, stop = vi.fn()): number =>
    r.start({ dir: "sites/app", task: "build a thing", stop });

  it("lists a build as running once it starts", () => {
    const r = new BuildRegistry();
    const id = started(r);
    expect(r.get(id)?.status).toBe("running");
    expect(r.active()).toHaveLength(1);
  });

  /*
   * Waiting on a person is not the same as working, and telling them apart is
   * the reason to look at this page at all: one needs patience, the other
   * needs you.
   */
  it("distinguishes waiting on the owner from working", () => {
    const r = new BuildRegistry();
    const id = started(r);
    r.record(id, { kind: "permission", text: "waiting on you: run: npm install" });
    expect(r.get(id)?.status).toBe("waiting");
    expect(r.get(id)?.askedFor).toBe(1);

    r.record(id, { kind: "permission", text: "you approved: run: npm install" });
    expect(r.get(id)?.status).toBe("running");
  });

  it("stops a running build and says it did", () => {
    const stop = vi.fn();
    const r = new BuildRegistry();
    const id = started(r, stop);
    expect(r.stop(id)).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(r.get(id)?.status).toBe("stopped");
  });

  /*
   * The ordinary case for a build that finished while the owner was reading
   * about it. Not an error, and must not be reported as one.
   */
  it("says so plainly when there is nothing left to stop", () => {
    const r = new BuildRegistry();
    const id = started(r);
    r.finish(id, { ok: true, summary: "done", files: [] });
    expect(r.stop(id)).toBe(false);
    expect(r.get(id)?.status).toBe("done");
  });

  it("does not let a stop be overwritten by the finish that follows it", () => {
    const r = new BuildRegistry();
    const id = started(r);
    r.stop(id);
    // The aborted run still returns and reports its own version of events.
    // Taking that at face value told the owner the build had timed out when
    // in fact they had stopped it a moment earlier.
    r.finish(id, { ok: false, summary: "build timed out", files: ["a.ts"] });
    expect(r.get(id)?.status).toBe("stopped");
    expect(r.get(id)?.latest).toBe("stopped by you");
    // The files it managed to touch are still worth having.
    expect(r.get(id)?.files).toEqual(["a.ts"]);
  });

  it("keeps running builds above finished ones", () => {
    const r = new BuildRegistry();
    const first = started(r);
    r.finish(first, { ok: true, summary: "done", files: [] });
    const second = started(r);
    expect(r.list()[0]?.id).toBe(second);
  });

  it("does not grow without bound on a long-lived process", () => {
    const r = new BuildRegistry();
    for (let i = 0; i < 60; i++) {
      const id = started(r);
      r.finish(id, { ok: true, summary: "done", files: [] });
    }
    expect(r.list().length).toBeLessThanOrEqual(21);
  });

  it("caps what it remembers of a chatty build", () => {
    const r = new BuildRegistry();
    const id = started(r);
    for (let i = 0; i < 500; i++) {
      r.record(id, { kind: "tool", text: `step ${i}` });
    }
    const record = r.get(id)!;
    expect(record.events.length).toBeLessThanOrEqual(200);
    // The newest are the ones kept: an old head is no use for "what is it
    // doing now".
    expect(record.events.at(-1)?.text).toBe("step 499");
  });
});
