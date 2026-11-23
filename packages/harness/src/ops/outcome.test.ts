import { describe, expect, it } from "vitest";

import { cronOutcome } from "../cron/executor.js";
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

  it("fails a stored-steps run on any failed step, and skips one its condition held", () => {
    const results = [{ tool: "notify", content: "ok", isError: false }, { tool: "sql", content: "no such table: x", isError: true }];
    expect(cronOutcome({ ran: true, type: "actions", results })).toEqual({ status: "error", error: "sql: no such table: x" });
    expect(cronOutcome({ ran: false, reason: "condition" })).toEqual({ status: "skipped", error: null });
  });
});
