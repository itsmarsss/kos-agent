import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { ensureProfile, loadProfile, saveProfile } from "./profile.js";

describe("profile", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-profile-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("is undefined on first run", () => {
    expect(loadProfile(ws)).toBeUndefined();
  });

  it("seeds defaults plus overrides on first run and persists", () => {
    const p = ensureProfile(ws, { name: "Kenny", timezone: "America/New_York" });
    expect(p.name).toBe("Kenny");
    expect(p.timezone).toBe("America/New_York");
    expect(p.ownerId).toBe("owner");
    expect(loadProfile(ws)?.name).toBe("Kenny"); // written to disk
  });

  it("does not overwrite an existing profile", () => {
    saveProfile(ws, {
      ownerId: "owner",
      name: "Existing",
      timezone: "UTC",
      channels: {},
      preferences: {},
    });
    const p = ensureProfile(ws, { name: "Ignored" });
    expect(p.name).toBe("Existing");
  });
});
