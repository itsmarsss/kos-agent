import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import {
  offeredSkills,
  parseManifest,
  readSkills,
  renderSkillsSection,
  type SkillRecord,
} from "./manifest.js";

describe("a skill's manifest", () => {
  it("accepts a script and a prompt skill", () => {
    expect(parseManifest({ name: "tidy", description: "Tidy up", kind: "script", entry: "run.mjs" }, "tidy")).toMatchObject({ kind: "script", entry: "run.mjs" });
    expect(parseManifest({ name: "review", description: "Review a PR", kind: "prompt" }, "review")).toMatchObject({ kind: "prompt", instructions: "SKILL.md" });
  });

  it("refuses a name that could leave its directory", () => {
    // A name is a directory name and appears in a prompt. No separators, no
    // dots, nothing a path would read as traversal.
    for (const bad of ["../x", "a/b", "A", "", "with space", ".hidden"]) {
      expect(() => parseManifest({ name: bad, description: "d", kind: "prompt" }, bad)).toThrow();
    }
  });

  it("refuses a manifest whose name is not its directory", () => {
    expect(() => parseManifest({ name: "one", description: "d", kind: "prompt" }, "two")).toThrow(/directory/);
  });

  it("keeps a script's entry inside the skill, and a script", () => {
    expect(() => parseManifest({ name: "s", description: "d", kind: "script", entry: "../run.mjs" }, "s")).toThrow();
    expect(() => parseManifest({ name: "s", description: "d", kind: "script", entry: "run.py" }, "s")).toThrow();
  });
});

describe("reading the skills in a workspace", () => {
  let root: string;
  let ws: Workspace;

  function skill(name: string, manifest: Record<string, unknown>, files: Record<string, string>): void {
    const dir = join(ws.root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify(manifest), "utf8");
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body, "utf8");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-skillman-"));
    ws = Workspace.open(root);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("finds valid skills and says why the others are not", () => {
    skill("good", { name: "good", description: "Works", kind: "prompt" }, { "SKILL.md": "do it" });
    skill("nofile", { name: "nofile", description: "Missing", kind: "script", entry: "run.mjs" }, {});
    mkdirSync(join(ws.root, "skills", "bare"), { recursive: true });
    const { skills, invalid } = readSkills(ws);
    expect(skills.map((s) => s.manifest.name)).toEqual(["good"]);
    expect(invalid).toEqual([
      { name: "bare", reason: "no skill.json" },
      { name: "nofile", reason: "skills/nofile/run.mjs does not exist" },
    ]);
  });

  it("is empty, not an error, when there is no skills directory", () => {
    expect(readSkills(ws)).toEqual({ skills: [], invalid: [] });
  });
});

describe("what is offered", () => {
  const rec = (name: string, projects?: string[]): SkillRecord => ({
    manifest: { name, description: `${name} desc`, kind: "prompt", instructions: "SKILL.md", ...(projects ? { projects } : {}) },
    dir: `skills/${name}`,
    file: `skills/${name}/SKILL.md`,
  });

  it("leaves out what the owner switched off", () => {
    expect(offeredSkills([rec("a"), rec("b")], ["b"]).map((s) => s.manifest.name)).toEqual(["a"]);
  });

  it("scopes a skill to its projects when a project is in play", () => {
    const all = [rec("any"), rec("books", ["book_tracker"])];
    expect(offeredSkills(all, [], "budget").map((s) => s.manifest.name)).toEqual(["any"]);
    expect(offeredSkills(all, [], "book_tracker").map((s) => s.manifest.name)).toEqual(["any", "books"]);
    // With no project in play, a scoped skill is still listed, with its scope.
    expect(offeredSkills(all, []).map((s) => s.manifest.name)).toEqual(["any", "books"]);
  });

  it("renders in name order whatever order they were read in", () => {
    const a = renderSkillsSection([rec("zeta"), rec("alpha")]);
    const b = renderSkillsSection([rec("alpha"), rec("zeta")]);
    expect(a).toBe(b);
    expect(a!.indexOf("alpha")).toBeLessThan(a!.indexOf("zeta"));
    expect(a).toContain("- alpha (prompt): alpha desc");
    expect(renderSkillsSection([])).toBeUndefined();
  });
});
