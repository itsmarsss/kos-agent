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

  it("does not eat the full stop that ends the sentence", () => {
    // "@schedule:kos.backup." resolved as a job called "kos.backup." and was
    // reported to the owner as not existing.
    expect(parseMentions("check @schedule:kos.backup.")).toEqual([
      { kind: "schedule", id: "kos.backup" },
    ]);
    expect(parseMentions("see @file:notes/a.md, then stop")).toEqual([
      { kind: "file", id: "notes/a.md" },
    ]);
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
    // A Python venv or a node_modules alone is enough to bury everything the
    // owner might actually be reaching for.
    mkdirSync(join(root, "venv", "lib"), { recursive: true });
    writeFileSync(join(root, "venv", "lib", "thing.py"), "x");
    mkdirSync(join(root, "__pycache__"), { recursive: true });
    writeFileSync(join(root, "__pycache__", "m.pyc"), "x");
    mkdirSync(join(root, ".venv"), { recursive: true });
    writeFileSync(join(root, ".venv", "cfg"), "x");
    writeFileSync(join(root, ".env"), "SECRET=1");

    const files = walkFiles(ws);
    for (const noise of [".git", "venv", "__pycache__", ".venv", ".env"]) {
      expect(files.some((f) => f.includes(noise))).toBe(false);
    }
    // The owner's own files are still there.
    expect(files).toContain("notes/todo.md");
  });

  it("keeps a source file that merely lives in a normal folder", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.py"), "print(1)");
    expect(walkFiles(ws)).toContain("src/main.py");
  });
});

describe("narrowing to one kind", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-kind-"));
    ws = Workspace.open(root);
    writeFileSync(join(root, "budget.md"), "x");
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const sources = () => ({
    projects: [{ slug: "budget_tracker", name: "Budget Tracker", type: "budget" }],
    pages: [{ id: "budget-dash", title: "Budget", projectSlug: "budget_tracker" }],
    crons: [{ name: "budget-nightly", schedule: "0 3 * * *" }],
    workspace: ws,
  });

  it("returns only the kind asked for", () => {
    const hits = findMentions(sources(), "budget", 12, "file");
    expect(hits.every((h) => h.kind === "file")).toBe(true);
    expect(hits.map((h) => h.id)).toContain("budget.md");
  });

  it("returns every kind when none is asked for", () => {
    const kinds = new Set(findMentions(sources(), "budget").map((h) => h.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it("returns nothing for a kind with no matches", () => {
    expect(findMentions(sources(), "nothingmatches", 12, "page")).toEqual([]);
  });
});
