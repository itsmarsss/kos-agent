// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuditRecord, RunRecord } from "./api.js";
import { dayLabel, HistoryPage, merge, runKind } from "./HistoryPage.js";

beforeAll(() => {
  // jsdom has no ResizeObserver; the page's search box and scrollbar watch their size with one.
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

const DAY = 86_400_000;

function tool(id: number, at: number): AuditRecord {
  return {
    id,
    tool: "files.write",
    args: "{}",
    result: "",
    isError: false,
    createdAt: at,
  };
}

function run(id: number, at: number): RunRecord {
  return {
    id,
    kind: "cron",
    ref: "1",
    status: "ok",
    error: null,
    startedAt: at,
    finishedAt: at + 10,
    durationMs: 10,
  };
}

describe("merging the two histories", () => {
  it("interleaves tools and runs by time, newest first", () => {
    const now = Date.now();
    const rows = merge(
      [tool(1, now - 3000), tool(2, now - 1000)],
      [run(9, now - 2000)],
    );
    // Two pages meant reading both and merging them by eye to find out what
    // happened in what order.
    expect(rows.map((r) => (r.kind === "tool" ? `t${r.tool.id}` : `r${r.run.id}`)))
      .toEqual(["t2", "r9", "t1"]);
  });

  it("marks failures from either side", () => {
    const now = Date.now();
    const rows = merge(
      [{ ...tool(1, now), isError: true }],
      [{ ...run(2, now), status: "error", error: "boom" }],
    );
    expect(rows.every((r) => r.failed)).toBe(true);
  });

  it("copes with one side being empty", () => {
    expect(merge([], [run(1, Date.now())])).toHaveLength(1);
    expect(merge([tool(1, Date.now())], [])).toHaveLength(1);
    expect(merge([], [])).toEqual([]);
  });
});

describe("day labels", () => {
  const noon = new Date(2026, 8, 1, 12, 0, 0).getTime();

  it("names the recent days rather than dating them", () => {
    expect(dayLabel(noon, noon)).toBe("Today");
    expect(dayLabel(noon - DAY, noon)).toBe("Yesterday");
  });

  it("uses the weekday within the week, then a date", () => {
    // Anything a week back would repeat a weekday name, and "Tuesday" that
    // could mean either of two Tuesdays is worse than a date.
    expect(dayLabel(noon - 3 * DAY, noon)).toMatch(/day$/);
    expect(dayLabel(noon - 30 * DAY, noon)).toMatch(/\d/);
  });

  it("counts calendar days, not elapsed hours", () => {
    // 1am today and 11pm yesterday are two hours apart and two different days.
    const oneAm = new Date(2026, 8, 1, 1, 0, 0).getTime();
    const elevenPmYesterday = new Date(2026, 7, 31, 23, 0, 0).getTime();
    expect(dayLabel(oneAm, oneAm)).toBe("Today");
    expect(dayLabel(elevenPmYesterday, oneAm)).toBe("Yesterday");
  });
});

describe("run kinds", () => {
  it("names a run's kind as the owner would, never the table's word", () => {
    expect(runKind("chat")).toBe("Chat");
    expect(runKind("cron")).toBe("Schedule");
    expect(runKind("memory.facts")).toBe("Memory");
  });
});

describe("the Runs rows", () => {
  it("say a step by what it did and to what, never its tool's name, an id or its arguments", () => {
    const at = Date.now();
    render(
      <HistoryPage
        tools={[
          { id: 1, tool: "files.ls", args: JSON.stringify({ path: "notes" }), result: "", isError: false, createdAt: at },
          { id: 2, tool: "secrets.write", args: JSON.stringify({ handle: "visa-ending-4242-d6xh", kind: "card", fields: ["number"] }), result: "", isError: false, createdAt: at - 1 },
          { id: 3, tool: "artifact.trash", args: JSON.stringify({ id: "reading-shelf" }), result: "", isError: false, createdAt: at - 2 },
        ]}
        runs={[{ id: 9, kind: "chat", ref: "c1", status: "error", error: "tool error: ENOENT: no such file or directory, open '/Users/me/ws/notes/missing-file.md'", startedAt: at - 3 } as never]}
        crons={[]}
        onOpenTool={() => {}}
        onOpenRun={() => {}}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(screen.getByText("List files")).toBeTruthy();
    expect(screen.getByText("Save a secret")).toBeTruthy();
    expect(screen.getByText("Move an artifact to the trash")).toBeTruthy();
    expect(text).toContain("There is no file or folder called “missing-file.md”.");
    for (const leak of ["files.ls", "secrets.write", "handle=", "reading-shelf", "/Users/", "ENOENT"]) expect(text).not.toContain(leak);
  });

  it("show where the rows will be while they are read, never Nothing has happened yet", () => {
    render(<HistoryPage loading tools={[]} runs={[]} crons={[]} onOpenTool={() => {}} onOpenRun={() => {}} />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Nothing has happened yet.");
    expect(document.body.textContent).not.toContain("0 of 0");
  });
});
