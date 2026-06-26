import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JailError } from "../jail/resolvePath.js";
import { DB_FILENAME, Workspace } from "./workspace.js";

describe("Workspace", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-ws-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the root and opens a sqlite db file", () => {
    expect(existsSync(join(ws.root, DB_FILENAME))).toBe(true);
  });

  it("creates the root directory if it does not exist", () => {
    const nested = join(root, "deep", "nested", "ws");
    const w = Workspace.open(nested);
    expect(existsSync(w.root)).toBe(true);
    w.close();
  });

  it("runs a basic sql round-trip", () => {
    ws.db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    ws.db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
    const row = ws.db.prepare("SELECT v FROM t WHERE id = 1").get() as {
      v: string;
    };
    expect(row.v).toBe("hello");
  });

  it("resolves workspace-relative paths through the jail", () => {
    expect(ws.resolve("a/b.txt")).toBe(join(ws.root, "a", "b.txt"));
  });

  it("rejects escapes via the workspace jail gate", () => {
    writeFileSync(join(ws.root, "f.txt"), "x");
    expect(() => ws.resolve("../escape")).toThrow(JailError);
  });
});
