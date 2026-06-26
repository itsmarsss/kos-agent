import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JailError, resolvePath } from "./resolvePath.js";

describe("resolvePath", () => {
  let root: string;

  beforeEach(() => {
    // realpath so macOS /var -> /private/var symlink does not confuse the gate
    root = realpathSync(mkdtempSync(join(tmpdir(), "kos-jail-")));
    mkdirSync(join(root, "projects", "budget"), { recursive: true });
    writeFileSync(join(root, "projects", "budget", "data.txt"), "x");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("allows paths inside the workspace", () => {
    it("resolves a relative path to an absolute path under root", () => {
      expect(resolvePath(root, "projects/budget/data.txt")).toBe(
        join(root, "projects", "budget", "data.txt"),
      );
    });

    it("treats empty and dot as the root itself", () => {
      expect(resolvePath(root, "")).toBe(root);
      expect(resolvePath(root, ".")).toBe(root);
    });

    it("allows a not-yet-existing leaf (for writes and mkdir)", () => {
      expect(resolvePath(root, "projects/new/file.sqlite")).toBe(
        join(root, "projects", "new", "file.sqlite"),
      );
    });

    it("allows an absolute path that stays within root", () => {
      const inside = join(root, "projects", "budget");
      expect(resolvePath(root, inside)).toBe(inside);
    });
  });

  describe("rejects traversal", () => {
    it("rejects a simple parent escape", () => {
      expect(() => resolvePath(root, "../secret")).toThrow(JailError);
    });

    it("rejects a nested parent escape", () => {
      expect(() => resolvePath(root, "projects/../../etc/passwd")).toThrow(
        JailError,
      );
    });

    it("rejects internal .. even when it would normalize back inside", () => {
      // projects/budget/../budget stays inside but is still refused by contract
      expect(() => resolvePath(root, "projects/budget/../budget")).toThrow(
        JailError,
      );
    });

    it("rejects backslash-separated traversal", () => {
      expect(() => resolvePath(root, "..\\secret")).toThrow(JailError);
    });
  });

  describe("rejects absolute escapes", () => {
    it("rejects an absolute path outside root", () => {
      expect(() => resolvePath(root, "/etc/passwd")).toThrow(JailError);
    });

    it("rejects a sibling directory that shares a prefix", () => {
      const sibling = `${root}-evil`;
      expect(() => resolvePath(root, sibling)).toThrow(JailError);
    });
  });

  describe("rejects symlinks", () => {
    it("rejects a symlinked file inside the workspace", () => {
      const target = join(root, "outside.txt");
      writeFileSync(resolve("/tmp", "kos-symlink-target.txt"), "secret");
      symlinkSync(resolve("/tmp", "kos-symlink-target.txt"), target);
      expect(() => resolvePath(root, "outside.txt")).toThrow(/symlink/);
    });

    it("rejects a path that descends through a symlinked directory", () => {
      const linkDir = join(root, "link");
      symlinkSync(tmpdir(), linkDir);
      expect(() => resolvePath(root, "link/passwd")).toThrow(/symlink/);
    });

    it("rejects a symlink even when its target is inside root", () => {
      const linkDir = join(root, "selflink");
      symlinkSync(join(root, "projects"), linkDir);
      expect(() => resolvePath(root, "selflink/budget")).toThrow(/symlink/);
    });
  });

  describe("rejects malformed input", () => {
    it("rejects a NUL byte", () => {
      expect(() => resolvePath(root, "a\0b")).toThrow(JailError);
    });

    it("rejects a non-absolute root", () => {
      expect(() => resolvePath("relative/root", "file")).toThrow(JailError);
    });
  });
});
