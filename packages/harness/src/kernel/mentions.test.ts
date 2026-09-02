import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import {
  findMentions,
  mentionToken,
  parseMentions,
  walkFiles,
  writeMention,
} from "./mentions.js";

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

/**
 * Names with spaces in them.
 *
 * The token pattern allowed no spaces, and a schedule is mentioned by its
 * name, which the owner wrote and which usually has spaces in it. The picker
 * inserted "@schedule:9 AM Pinger Test" and the parser read "@schedule:9",
 * so mentioning most jobs quietly resolved to nothing or to the wrong thing.
 */
describe("mentions with spaces", () => {
  it("reads a bracketed id whole", () => {
    expect(parseMentions("look at @schedule:[9 AM Pinger Test] please")).toEqual([
      { kind: "schedule", id: "9 AM Pinger Test" },
    ]);
  });

  it("still reads the plain form", () => {
    expect(parseMentions("@project:budget_tracker")).toEqual([
      { kind: "project", id: "budget_tracker" },
    ]);
  });

  it("does not run past the closing bracket", () => {
    expect(parseMentions("@schedule:[nightly digest] and @project:kitchen_redo")).toEqual([
      { kind: "schedule", id: "nightly digest" },
      { kind: "project", id: "kitchen_redo" },
    ]);
  });

  it("ignores an unclosed bracket rather than swallowing the message", () => {
    expect(parseMentions("@schedule:[never closed")).toEqual([]);
  });

  it("dedupes across the two forms", () => {
    expect(parseMentions("@project:[budget_tracker] @project:budget_tracker")).toEqual([
      { kind: "project", id: "budget_tracker" },
    ]);
  });
});

describe("writing a mention", () => {
  it("brackets an id that needs it", () => {
    expect(writeMention("schedule", "9 AM Pinger Test")).toBe(
      "@schedule:[9 AM Pinger Test]",
    );
  });

  it("leaves a plain id alone", () => {
    expect(writeMention("project", "budget_tracker")).toBe(
      "@project:budget_tracker",
    );
  });

  it("round-trips whatever it writes", () => {
    for (const id of ["a b", "plain", "with-dash", "a/b", "9 AM Pinger Test"]) {
      expect(parseMentions(writeMention("schedule", id))).toEqual([
        { kind: "schedule", id },
      ]);
    }
  });
});

/**
 * The agent writes these too, not only the picker. It produced
 * "@schedule:9 AM Pinger Test" from its own prose, which rendered as a chip
 * reading "9" with the rest of the name left as text beside it.
 */
describe("what the agent is told to write", () => {
  it("round-trips a job name with spaces", () => {
    const written = writeMention("schedule", "9 AM Pinger Test");
    expect(parseMentions(`Turning off ${written} for now.`)).toEqual([
      { kind: "schedule", id: "9 AM Pinger Test" },
    ]);
  });

  it("still reads a bare name as far as it can, rather than not at all", () => {
    // The unbracketed form remains valid for ids that have no spaces, and a
    // name with one degrades to its first word rather than breaking the
    // message around it.
    expect(parseMentions("@schedule:9 AM Pinger Test")).toEqual([
      { kind: "schedule", id: "9" },
    ]);
  });
});
