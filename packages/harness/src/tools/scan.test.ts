import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scan } from "./scan.js";

/**
 * Searching without ripgrep.
 *
 * search.grep threw when ripgrep was absent, which takes a core capability
 * away based on what the owner happens to have installed. Note that `rg` on an
 * interactive PATH proves nothing: it is often a shell function, and a spawned
 * process cannot call one.
 */
describe("scanning the workspace", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-scan-"));
    writeFileSync(join(root, "notes.md"), "alpha\nbeta needle here\ngamma");
    writeFileSync(join(root, "code.ts"), "const needle = 1;\nconst other = 2;");
    mkdirSync(join(root, "deep", "nested"), { recursive: true });
    writeFileSync(join(root, "deep", "nested", "buried.txt"), "a needle deep down");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds matches in ripgrep's shape: path, line, text", () => {
    const { lines } = scan(root, root, "needle");
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.startsWith("notes.md:2:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("code.ts:1:"))).toBe(true);
    // Paths are relative to the root, as ripgrep reports them.
    expect(lines.every((l) => !l.startsWith("/"))).toBe(true);
  });

  it("searches subdirectories", () => {
    const { lines } = scan(root, root, "deep down");
    expect(lines[0]).toContain("deep/nested/buried.txt");
  });

  it("can be pointed at one file", () => {
    const { lines } = scan(root, join(root, "code.ts"), "needle");
    expect(lines).toHaveLength(1);
  });

  it("returns nothing rather than failing when there is nothing", () => {
    expect(scan(root, root, "nothingmatchesthis").lines).toEqual([]);
  });

  it("treats the pattern as a regular expression", () => {
    expect(scan(root, root, "^const").lines).toHaveLength(2);
    expect(scan(root, root, "b(eta|uried)").lines.length).toBeGreaterThan(0);
  });

  it("says so when the pattern is not one", () => {
    expect(() => scan(root, root, "([")).toThrow(/not a valid pattern/);
  });

  /*
   * The directories a search is never meant to walk. Without this a workspace
   * with one node_modules in it takes minutes and returns other people's code.
   */
  it("skips dependency and build directories", () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "needle");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "out.js"), "needle");
    const { lines } = scan(root, root, "needle");
    expect(lines.every((l) => !l.includes("node_modules"))).toBe(true);
    expect(lines.every((l) => !l.startsWith("dist/"))).toBe(true);
  });

  it("does not grep a binary", () => {
    writeFileSync(join(root, "blob.txt"), Buffer.from([0x6e, 0x00, 0x65, 0x65]));
    expect(scan(root, root, "n").lines.every((l) => !l.startsWith("blob"))).toBe(true);
  });

  it("stops rather than returning everything a huge tree contains", () => {
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, `f${i}.txt`), "needle\n".repeat(30));
    }
    const { lines, truncated } = scan(root, root, "needle", { maxMatches: 50 });
    expect(lines).toHaveLength(50);
    expect(truncated).toBe(true);
  });

  it("does not choke on a directory it cannot read", () => {
    expect(() => scan(root, join(root, "does-not-exist"), "x")).not.toThrow();
    expect(scan(root, join(root, "does-not-exist"), "x").lines).toEqual([]);
  });
});
