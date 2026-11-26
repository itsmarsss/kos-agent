import { describe, expect, it } from "vitest";

import { cronOutcome, selfPromptResult } from "../cron/executor.js";
import { outcomeOf } from "./outcome.js";

const steps = (total: number, failed: number) => ({ total, failed, firstError: failed ? "files.read: ENOENT: no such file" : null });

describe("a run's outcome", () => {
  it("is Done with no failed step, however many it took", () => {
    expect(outcomeOf(steps(0, 0), true)).toEqual({ status: "ok", error: null });
    expect(outcomeOf(steps(4, 0), false)).toEqual({ status: "ok", error: null });
  });

  it("fails a schedule whose every step failed, with the first failure", () => {
    expect(outcomeOf(steps(2, 2), true)).toEqual({ status: "error", error: "All 2 of its steps failed. files.read: ENOENT: no such file" });
    expect(outcomeOf(steps(1, 1), true).status).toBe("error");
  });

  it("finishes with errors when only some failed, or when the owner watched", () => {
    expect(outcomeOf(steps(3, 1), true)).toEqual({ status: "partial", error: "1 of 3 steps failed." });
    expect(outcomeOf(steps(2, 2), false)).toEqual({ status: "partial", error: "2 of 2 steps failed." });
    expect(outcomeOf(steps(1, 1), false)).toEqual({ status: "partial", error: "Its one step failed." });
  });
});

describe("a schedule's outcome", () => {
  it("reads an Ask KOS run by its steps, never its reply", () => {
    expect(cronOutcome({ ran: true, type: "self_prompt", finalText: "Done. All good.", steps: steps(2, 2) }).status).toBe("error");
    expect(cronOutcome({ ran: true, type: "self_prompt", finalText: "Done.", steps: steps(2, 0) }).status).toBe("ok");
  });

  it("fails a job written to post with notify that posted nothing, with why", () => {
    const digest = { prompt: 'Post the digest: use notify with to="discord:channel:1".' };
    const lapsed = { total: 5, failed: 1, firstError: "notify: its approval was left undecided" };
    expect(cronOutcome(selfPromptResult(digest, { reply: "Not posted.", steps: lapsed, delivered: 0, quiet: 0 }))).toEqual({
      status: "error",
      error: "It was written to post with notify, and posted nothing: notify: its approval was left undecided",
    });
    expect(cronOutcome(selfPromptResult(digest, { reply: "Posted.", steps: steps(5, 0), delivered: 1, quiet: 0 })).status).toBe("ok");
    // A job that never said notify is judged by its steps alone.
    expect(cronOutcome(selfPromptResult({ prompt: "Tidy the table." }, { reply: "Done.", steps: steps(2, 0), delivered: 0, quiet: 0 })).status).toBe("ok");
  });

  it("passes a job written to post with notify that said it chose not to, and still fails one that did not say", () => {
    const scan = { prompt: "Post any new opening with notify. If there is none, send nothing: silence is the correct result." };
    const reply = "Nothing worth sending this hour.";
    expect(cronOutcome(selfPromptResult(scan, { reply, steps: steps(3, 0), delivered: 0, quiet: 1 }))).toEqual({ status: "ok", error: null });
    // The same reply with no quiet ending is a message never sent.
    expect(cronOutcome(selfPromptResult(scan, { reply, steps: steps(2, 0), delivered: 0, quiet: 0 }))).toEqual({
      status: "error",
      error: "It was written to post with notify, and posted nothing.",
    });
    // A notify that errored delivered nothing and declared nothing: it fails, with the error.
    const refused = { total: 2, failed: 1, firstError: "notify: Discord is not connected" };
    expect(cronOutcome(selfPromptResult(scan, { reply, steps: refused, delivered: 0, quiet: 0 }))).toEqual({
      status: "error",
      error: "It was written to post with notify, and posted nothing: notify: Discord is not connected",
    });
  });

  it("lets a quiet ending stand only over a run where nothing else failed", () => {
    const scan = { prompt: "Post any new opening with notify; most hours, send nothing." };
    const failedPost = { total: 3, failed: 1, firstError: "notify: Discord is not connected" };
    expect(cronOutcome(selfPromptResult(scan, { reply: "Could not post.", steps: failedPost, delivered: 0, quiet: 1 }))).toEqual({
      status: "error",
      error: "It ended without posting after a step failed: notify: Discord is not connected",
    });
    const failedWork = { total: 4, failed: 1, firstError: "skills.run: exit 1" };
    expect(cronOutcome(selfPromptResult(scan, { reply: "Nothing to post.", steps: failedWork, delivered: 0, quiet: 1 }))).toMatchObject({ status: "error" });
    // A refused quiet ending is left out of the steps and kept only as words: a run that put it right is ok.
    const corrected = { total: 2, failed: 0, firstError: "notify: quiet posts nothing, so it takes no text" };
    expect(cronOutcome(selfPromptResult(scan, { reply: "Nothing new.", steps: corrected, delivered: 0, quiet: 1 }))).toEqual({ status: "ok", error: null });
    // Never put right, its words say why nothing went.
    expect(cronOutcome(selfPromptResult(scan, { reply: "Nothing new.", steps: corrected, delivered: 0, quiet: 0 }))).toEqual({
      status: "error",
      error: "It was written to post with notify, and posted nothing: notify: quiet posts nothing, so it takes no text",
    });
  });

  it("fails a turn that ended without its reply, with why", () => {
    expect(cronOutcome(selfPromptResult({ prompt: "notify me" }, { reply: "", steps: steps(1, 0), delivered: 0, quiet: 0, stopped: "the SDK process exited" }))).toEqual({
      status: "error",
      error: "Stopped before it finished: the SDK process exited",
    });
  });

  it("fails a stored-steps run on any failed step, and skips one its condition held", () => {
    const results = [{ tool: "notify", content: "ok", isError: false }, { tool: "sql", content: "no such table: x", isError: true }];
    expect(cronOutcome({ ran: true, type: "actions", results })).toEqual({ status: "error", error: "sql: no such table: x" });
    expect(cronOutcome({ ran: false, reason: "condition" })).toEqual({ status: "skipped", error: null });
  });
});
