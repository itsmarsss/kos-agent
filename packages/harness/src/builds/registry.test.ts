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
  const control = () => ({
    send: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(),
  });

  const started = (r: BuildRegistry, c = control()): number =>
    r.start({ dir: "sites/app", task: "build a thing", control: c });

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
    const c = control();
    const r = new BuildRegistry();
    const id = started(r, c);
    expect(r.stop(id)).toBe(true);
    expect(c.stop).toHaveBeenCalled();
    expect(r.get(id)?.status).toBe("stopped");
  });

  /*
   * The difference between watching an agent go the wrong way and being able
   * to say so. A build that can only be killed is one you start over rather
   * than correct.
   */
  it("passes a message to a build that is still going", () => {
    const c = control();
    const r = new BuildRegistry();
    const id = started(r, c);
    r.record(id, { kind: "permission", text: "waiting on you: run: rm -rf ." });
    expect(r.get(id)?.status).toBe("waiting");

    expect(r.send(id, "use the other folder")).toBe(true);
    expect(c.send).toHaveBeenCalledWith("use the other folder");
    // Still waiting: a message is not an answer to a permission prompt. The
    // build is blocked on "may I run this" and stays blocked until that is
    // decided, whatever else is said to it in the meantime.
    expect(r.get(id)?.status).toBe("waiting");
  });

  it("interrupts without ending it", async () => {
    const c = control();
    const r = new BuildRegistry();
    const id = started(r, c);
    expect(await r.interrupt(id)).toBe(true);
    expect(c.interrupt).toHaveBeenCalled();
    // Still there to be redirected, which is the point of interrupting
    // rather than stopping.
    expect(r.get(id)?.status).toBe("running");
  });

  it("has nothing to say to a build that already finished", async () => {
    const r = new BuildRegistry();
    const id = started(r);
    r.finish(id, { ok: true, summary: "done", files: [] });
    expect(r.send(id, "hello")).toBe(false);
    expect(await r.interrupt(id)).toBe(false);
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

  /*
   * The cap exists so a runaway build cannot fill memory, not to summarise.
   * It was 200, which meant opening a build that had worked for ten minutes
   * showed the tail and nothing of how it got there; the log is meant to be
   * read like a terminal.
   */
  it("keeps enough to read like a log, and still caps it", () => {
    const r = new BuildRegistry();
    const id = started(r);
    for (let i = 0; i < 5000; i++) {
      r.record(id, { kind: "tool", text: `step ${i}` });
    }
    const record = r.get(id)!;
    expect(record.events.length).toBeGreaterThan(1000);
    expect(record.events.length).toBeLessThanOrEqual(2000);
    // The newest are the ones kept: an old head is no use for "what is it
    // doing now".
    expect(record.events.at(-1)?.text).toBe("step 4999");
  });
});

/**
 * Telling thinking apart from wedged.
 *
 * Both say "running" and produce nothing, so from outside they are the same
 * picture. A build that has gone quiet for minutes is worth naming rather than
 * leaving the owner to watch a spinner and guess.
 */
describe("a build that has gone quiet", () => {
  const control = () => ({
    send: () => undefined,
    interrupt: async () => undefined,
    stop: () => undefined,
  });

  it("is not flagged while it is producing", () => {
    const r = new BuildRegistry();
    const id = r.start({ dir: "d", task: "t", control: control(), now: 0 });
    r.record(id, { kind: "tool", text: "working" }, 1000);
    expect(r.list(2000)[0]?.quietFor).toBe(0);
  });

  it("is flagged once it has said nothing for long enough", () => {
    const r = new BuildRegistry();
    const id = r.start({ dir: "d", task: "t", control: control(), now: 0 });
    r.record(id, { kind: "tool", text: "working" }, 1000);
    const quiet = r.list(1000 + 4 * 60_000)[0]?.quietFor ?? 0;
    expect(quiet).toBeGreaterThan(3 * 60_000);
  });

  /*
   * A build waiting on the owner is not stalled: it is doing exactly what it
   * should, and calling that stuck would train them to ignore the flag.
   */
  it("is not flagged while it waits on the owner", () => {
    const r = new BuildRegistry();
    const id = r.start({ dir: "d", task: "t", control: control(), now: 0 });
    r.record(id, { kind: "permission", text: "waiting on you: run: x" }, 1000);
    expect(r.list(1000 + 10 * 60_000)[0]?.quietFor).toBe(0);
  });

  it("is not flagged once it has finished", () => {
    const r = new BuildRegistry();
    const id = r.start({ dir: "d", task: "t", control: control(), now: 0 });
    r.finish(id, { ok: true, summary: "done", files: [] }, 1000);
    expect(r.list(1000 + 10 * 60_000)[0]?.quietFor).toBe(0);
  });
});
