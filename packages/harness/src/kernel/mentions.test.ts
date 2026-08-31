import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { findMentions, mentionToken, parseMentions, walkFiles } from "./mentions.js";

describe("parseMentions", () => {
  it("pulls references out in order", () => {
    expect(
      parseMentions("compare @project:budget with @file:notes/a.md please"),
    ).toEqual([
      { kind: "project", id: "budget" },
      { kind: "file", id: "notes/a.md" },
    ]);
  });

  it("dedupes, so a file named twice is not attached twice", () => {
    expect(parseMentions("@file:a.md and again @file:a.md")).toHaveLength(1);
  });

  it("ignores an @ that is not a reference", () => {
    expect(parseMentions("mail me@example.com about @stuff")).toEqual([]);
  });

  it("round-trips a mention token", () => {
    expect(mentionToken({ kind: "file", id: "a/b.md", label: "b.md" })).toBe(
      "@file:a/b.md",
    );
    expect(parseMentions(mentionToken({ kind: "page", id: "p1", label: "P" }))).toEqual(
      [{ kind: "page", id: "p1" }],
    );
  });
});

describe("findMentions", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-mentions-"));
    ws = Workspace.open(root);
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "todo.md"), "x");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "x");
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const sources = () => ({
    projects: [{ slug: "budget_tracker", name: "Budget Tracker", type: "budget" }],
    pages: [{ id: "budget-dash", title: "Budget", projectSlug: "budget_tracker" }],
    crons: [{ name: "WeekdaySummary", schedule: "0 9 * * 1-5" }],
    workspace: ws,
  });

  it("searches across every kind at once", () => {
    const kinds = new Set(findMentions(sources(), "").map((m) => m.kind));
    expect(kinds).toContain("project");
    expect(kinds).toContain("page");
    expect(kinds).toContain("schedule");
    expect(kinds).toContain("file");
  });

  it("ranks a prefix match above one buried in the middle", () => {
    const hits = findMentions(sources(), "budget");
    expect(hits[0]?.label).toBe("Budget");
  });

  it("finds a file by its path", () => {
    expect(findMentions(sources(), "todo").map((m) => m.id)).toContain(
      "notes/todo.md",
    );
  });

  it("leaves machinery out of the picker", () => {
    // .git is not the owner's work and would swamp everything else.
    expect(walkFiles(ws).some((p) => p.includes(".git"))).toBe(false);
  });
});
