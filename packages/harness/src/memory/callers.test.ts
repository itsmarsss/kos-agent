import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { CallerStore, mayRead } from "./callers.js";

describe("callers", () => {
  let root: string;
  let ws: Workspace;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-callers-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("hands the token over once and keeps only a hash of it", () => {
    const store = new CallerStore(ws.db, () => 42);
    const { caller, token } = store.create("resume-ops", { readTags: ["career", " resume "], writeGlobal: false });
    expect(token.startsWith("kosc_")).toBe(true);
    expect(caller).toMatchObject({ name: "resume-ops", readTags: ["career", "resume"], writeGlobal: false, lastSeenAt: null });
    const raw = ws.db.prepare(`SELECT token_hash FROM memory_callers WHERE id = ?`).get(caller.id) as { token_hash: string };
    expect(raw.token_hash).not.toContain(token);
    expect(store.authenticate(token)?.name).toBe("resume-ops");
    expect(store.get(caller.id)?.lastSeenAt).toBe(42);
    expect(store.authenticate("kosc_wrong")).toBeUndefined();
    expect(store.authenticate("")).toBeUndefined();
  });

  it("refuses a bad or taken name, updates a grant, and revokes", () => {
    const store = new CallerStore(ws.db);
    expect(() => store.create("Bad Name")).toThrow(/not a caller name/);
    const { caller, token } = store.create("one");
    expect(() => store.create("one")).toThrow(/already exists/);
    expect(store.update(caller.id, { readTags: ["*"], writeGlobal: true })).toMatchObject({ readTags: ["*"], writeGlobal: true });
    expect(store.list().map((c) => c.name)).toEqual(["one"]);
    expect(store.revoke(caller.id)).toBe(true);
    expect(store.authenticate(token)).toBeUndefined();
    expect(store.revoke(caller.id)).toBe(false);
  });

  it("reads global only within its tags", () => {
    const narrow = { id: 1, name: "n", readTags: ["career"], writeGlobal: false, createdAt: 0, lastSeenAt: null };
    expect(mayRead(narrow, ["career", "x"])).toBe(true);
    expect(mayRead(narrow, ["home"])).toBe(false);
    expect(mayRead(narrow, [])).toBe(false);
    expect(mayRead({ ...narrow, readTags: ["*"] }, [])).toBe(true);
  });
});
