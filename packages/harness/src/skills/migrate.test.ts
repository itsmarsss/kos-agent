import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { readSkills, skillHash } from "./manifest.js";
import { legacySkillHash, migratePromoted } from "./migrate.js";

describe("promotions kept under the two-file hash", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kos-skill-migrate-")));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const skill = (name: string, body: string): void => {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "skill.json"), JSON.stringify({ name, description: "d", kind: "script", entry: "run.mjs" }));
    writeFileSync(join(root, "skills", name, "run.mjs"), body);
  };
  const record = (name: string) => readSkills(ws).skills.find((s) => s.manifest.name === name)!;

  it("carries a yes over to the folder hash where the approved files are the files there", () => {
    skill("board", "import './lib.mjs';");
    writeFileSync(join(root, "skills", "board", "lib.mjs"), "");
    const out = migratePromoted(ws, { board: legacySkillHash(ws, record("board")) });
    expect(out).toEqual({ promoted: { board: skillHash(ws, record("board")) }, carried: ["board"], stale: [] });
  });

  it("leaves one already on the folder hash, and names one changed since, gone, or holding a link", () => {
    skill("kept", "1");
    skill("changed", "1");
    skill("linked", "1");
    const old = legacySkillHash(ws, record("changed"));
    const linked = legacySkillHash(ws, record("linked"));
    writeFileSync(join(root, "skills", "changed", "run.mjs"), "2");
    symlinkSync(tmpdir(), join(root, "skills", "linked", "elsewhere"));
    const now = skillHash(ws, record("kept"));
    const out = migratePromoted(ws, { kept: now, changed: old, linked, gone: "abc" });
    expect(out.carried).toEqual([]);
    expect(out.stale.sort()).toEqual(["changed", "gone", "linked"]);
    expect(out.promoted.kept).toBe(now);
  });
});
