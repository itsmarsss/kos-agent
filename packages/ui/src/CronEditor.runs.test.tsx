// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type CronJob, type RunRecord } from "./api.js";
import { CronEditor, notRunWords, runWhy, spendWords } from "./CronEditor.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const run = (over: Partial<RunRecord>): RunRecord => ({ id: 1, kind: "cron", status: "ok", error: null, startedAt: Date.now() - 60_000, durationMs: 1200, ...over });
const sheet = (job: CronJob): void => {
  vi.spyOn(api, "skills").mockResolvedValue({ skills: [] } as unknown as Awaited<ReturnType<typeof api.skills>>);
  render(<CronEditor job={job} onDone={() => {}} onCancel={() => {}} onRunNow={() => {}} onToggle={() => {}} />);
};

describe("a schedule's last runs", () => {
  it("says why it has not run: off, or waiting for its first time", () => {
    expect(notRunWords({ enabled: false })).toBe("It is off, so it does not run. Resume turns it back on.");
    expect(notRunWords({ enabled: true })).toBe("It has not run yet.");
  });

  it("says why a run did nothing or what went wrong, in words", () => {
    expect(runWhy(run({ status: "skipped" }))).toBe("Its condition said not now, so it did nothing.");
    expect(runWhy(run({ status: "error", error: "Its one step failed. files.read: ENOENT: no such file or directory, open '/w/blobs/recap/notes/todo.md'" }))).toBe("There is no file or folder called “todo.md”.");
    expect(runWhy(run({ status: "ok" }))).toBeNull();
  });

  it("says why a missed run was skipped, and lists it as not run", () => {
    const reason = "missed by 4h; next run at Wed, Nov 26, 9:00 AM";
    expect(runWhy(run({ status: "skipped", error: reason }))).toBe("Missed by 4h; next run at Wed, Nov 26, 9:00 AM");
    sheet({ id: 4, name: "Kickoff", schedule: "0 9 * * *", type: "self_prompt", enabled: true, lastRuns: [run({ id: 3, status: "skipped", error: reason, durationMs: 0 })] });
    const list = screen.getByRole("region", { name: "Last runs" });
    expect(list.textContent).toContain("Not run");
    expect(list.textContent).toContain("Missed by 4h; next run at Wed, Nov 26, 9:00 AM");
  });

  it("lists each run's outcome on the sheet, failures in words", () => {
    sheet({ id: 3, name: "Recap", schedule: "0 17 * * 5", type: "self_prompt", enabled: true, lastRuns: [run({ id: 2, status: "error", error: "Its one step failed. sql: no such table: notes" }), run({ id: 1, status: "partial", error: "1 of 3 steps failed." })] });
    const list = screen.getByRole("region", { name: "Last runs" });
    expect(list.textContent).toContain("Failed");
    expect(list.textContent).toContain("There is no table called “notes”.");
    expect(list.textContent).toContain("With errors");
    expect(list.textContent).toContain("1 of 3 steps failed.");
  });

  it("never calls an Ask KOS job's runs free when no model use is on record", () => {
    expect(spendWords({ runs: 1, calls: 0, inputTokens: 0, outputTokens: 0 }, true)).toBe("1 run; no model use is on record for them.");
  });
});

describe("a blob's schedule", () => {
  it("shows its name as the lists do, never the store's id, and not to be changed", () => {
    sheet({ id: 6, name: "blob.recap", schedule: "0 17 * * 5", type: "self_prompt", enabled: true, prompt: "recap" });
    const field = screen.getByDisplayValue("Recap") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(screen.queryByDisplayValue("blob.recap")).toBeNull();
  });
});

describe("KOS's own schedule", () => {
  it("opens read-only, saying what it does, with no fields to break it", () => {
    sheet({ id: 9, name: "kos.improve", schedule: "0 5 * * 1", type: "self_prompt", enabled: false, prompt: "You are looking at your own work" });
    expect(screen.getByText(/suggests them to you in the Inbox/)).toBeTruthy();
    expect(screen.getByText("It is off, so it does not run. Resume turns it back on.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });
});

describe("a schedule's chat", () => {
  it("opens the thread its runs are written into, once it has one", () => {
    vi.spyOn(api, "skills").mockResolvedValue({ skills: [] } as unknown as Awaited<ReturnType<typeof api.skills>>);
    const opened: string[] = [];
    const job: CronJob = { id: 28, name: "School Morning Digest", schedule: "32 7 * * *", type: "self_prompt", enabled: true, conversationId: "cron:28" };
    const { rerender } = render(<CronEditor job={job} onDone={() => {}} onCancel={() => {}} onOpenChat={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole("button", { name: "Open its chat" }));
    expect(opened).toEqual(["cron:28"]);
    // Never run: no thread yet, so nothing to open.
    const { conversationId: _none, ...fresh } = job;
    rerender(<CronEditor job={fresh} onDone={() => {}} onCancel={() => {}} onOpenChat={(id) => opened.push(id)} />);
    expect(screen.queryByRole("button", { name: "Open its chat" })).toBeNull();
  });
});
