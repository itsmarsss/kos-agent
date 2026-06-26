import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { PersistentKillSwitch } from "./killswitch.js";

describe("PersistentKillSwitch", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-kill-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults to not halted and toggles", () => {
    const ks = new PersistentKillSwitch(ws.db);
    expect(ks.halted).toBe(false);
    ks.halt();
    expect(ks.halted).toBe(true);
    ks.resume();
    expect(ks.halted).toBe(false);
  });

  it("persists the halted state across instances", () => {
    new PersistentKillSwitch(ws.db).halt();
    const reopened = new PersistentKillSwitch(ws.db);
    expect(reopened.halted).toBe(true);
  });
});
