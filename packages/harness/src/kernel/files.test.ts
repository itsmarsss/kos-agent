import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { listDirectory, readFile } from "./files.js";

describe("workspace file browsing", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-files-"));
    ws = Workspace.open(root);
    mkdirSync(join(ws.root, "projects", "budget"), { recursive: true });
    writeFileSync(join(ws.root, "notes.md"), "# Notes\n\nhello");
    writeFileSync(join(ws.root, "projects", "budget", "spec.json"), '{"a":1}');
    writeFileSync(join(ws.root, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists directories before files, each by name", () => {
    const entries = listDirectory(ws, ".");
    const kinds = entries.map((e) => e.kind);
    expect(kinds.indexOf("dir")).toBeLessThan(kinds.lastIndexOf("file"));
    expect(entries.some((e) => e.name === "notes.md" && e.kind === "file")).toBe(true);
    expect(entries.some((e) => e.name === "projects" && e.kind === "dir")).toBe(true);
  });

  it("descends with a workspace-relative path", () => {
    const entries = listDirectory(ws, "projects/budget");
    expect(entries.map((e) => e.path)).toContain("projects/budget/spec.json");
  });

  it("treats an empty or root path as the workspace root", () => {
    expect(listDirectory(ws, "").length).toBeGreaterThan(0);
    expect(listDirectory(ws, "/").length).toBeGreaterThan(0);
  });

  it("reads a text file with its language", () => {
    const file = readFile(ws, "notes.md");
    expect(file.text).toContain("# Notes");
    expect(file.language).toBe("markdown");
  });

  it("omits a binary file rather than returning mojibake", () => {
    const file = readFile(ws, "photo.png");
    expect(file.text).toBeUndefined();
    expect(file.omitted).toBe("binary");
  });

  it("refuses to escape the workspace", () => {
    // The jail is the guard; browsing must not become a way around it.
    expect(() => listDirectory(ws, "../..")).toThrow();
    expect(() => readFile(ws, "../../etc/passwd")).toThrow();
    expect(() => readFile(ws, "/etc/passwd")).toThrow();
  });

  it("refuses a symlink even when it points somewhere real", () => {
    const outside = mkdtempSync(join(tmpdir(), "kos-outside-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    try {
      symlinkSync(outside, join(ws.root, "escape"));
      expect(() => listDirectory(ws, "escape")).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects reading a directory as a file", () => {
    expect(() => readFile(ws, "projects")).toThrow(/not a file/);
  });
});
