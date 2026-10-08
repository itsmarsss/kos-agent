import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { installSkill, manifestFromSkillMd, removeSkill, updateSkill } from "./install.js";
import { readSkills } from "./manifest.js";

describe("a manifest from a SKILL.md", () => {
  it("takes the name and description from the front matter", () => {
    const m = manifestFromSkillMd('---\nname: pdf-tables\ndescription: "Pull tables out of PDFs"\n---\n# PDF tables\n\nDo this.', "x");
    expect(m).toEqual({ name: "pdf-tables", description: "Pull tables out of PDFs", kind: "prompt", instructions: "SKILL.md" });
  });

  it("reads a description written as a YAML block, folded or literal", () => {
    const folded = manifestFromSkillMd("---\nname: guide\ndescription: >\n  Guides users through\n  a workflow.\nlicense: MIT\n---\n", "x");
    expect(folded.description).toBe("Guides users through a workflow.");
    const literal = manifestFromSkillMd("---\nname: api\ndescription: |-\n  Call the API.\n  Carefully.\n---\n", "x");
    expect(literal.description).toBe("Call the API. Carefully.");
  });

  it("falls back to the folder's name and the first line of prose", () => {
    const m = manifestFromSkillMd("# Receipts\n\nFile receipts by month.\n", "receipts");
    expect(m).toMatchObject({ name: "receipts", description: "File receipts by month." });
  });
});

describe("installing a skill", () => {
  let root: string;
  let ws: Workspace;
  let src: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-skill-install-"));
    ws = Workspace.open(root);
    src = mkdtempSync(join(tmpdir(), "kos-skill-src-"));
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  function folder(name: string, files: Record<string, string>): string {
    const dir = join(src, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text, "utf8");
    return dir;
  }

  it("copies a folder with a skill.json in, named by its manifest", async () => {
    const made = await installSkill(
      ws,
      folder("whatever", { "skill.json": JSON.stringify({ name: "tidy", description: "Tidies.", kind: "script", entry: "run.mjs" }), "run.mjs": "" }),
    );
    expect(made).toMatchObject({ name: "tidy", dir: "skills/tidy", origin: null });
    expect(readSkills(ws).skills.map((s) => s.manifest.name)).toEqual(["tidy"]);
    expect(existsSync(join(root, "skills", "whatever"))).toBe(false);
  });

  it("reads a Claude Code skill, a SKILL.md, as a prompt skill and gives it a manifest", async () => {
    const made = await installSkill(ws, folder("pdf-tables", { "SKILL.md": "---\nname: pdf-tables\ndescription: Pull tables out of PDFs\n---\nSteps." }));
    expect(made.manifest).toEqual({ name: "pdf-tables", description: "Pull tables out of PDFs", kind: "prompt", instructions: "SKILL.md" });
    expect(JSON.parse(readFileSync(join(root, "skills", "pdf-tables", "skill.json"), "utf8"))).toMatchObject({ kind: "prompt" });
    expect(readSkills(ws).skills).toHaveLength(1);
  });

  it("takes the name it is given, and tells the manifest", async () => {
    const made = await installSkill(
      ws,
      folder("x", { "skill.json": JSON.stringify({ name: "tidy", description: "Tidies.", kind: "script", entry: "run.mjs" }), "run.mjs": "" }),
      { name: "tidy2" },
    );
    expect(made.name).toBe("tidy2");
    expect(JSON.parse(readFileSync(join(root, "skills", "tidy2", "skill.json"), "utf8")).name).toBe("tidy2");
  });

  it("removes a folder that is not a skill, and says why", async () => {
    await expect(installSkill(ws, folder("junk", { "README.md": "hi" }))).rejects.toThrow(/not a skill: no skill\.json and no SKILL\.md/);
    await expect(
      installSkill(ws, folder("noentry", { "skill.json": JSON.stringify({ name: "noentry", description: "x", kind: "script", entry: "run.mjs" }) })),
    ).rejects.toThrow(/run\.mjs does not exist/);
    expect(existsSync(join(root, "skills", "junk"))).toBe(false);
    // Nothing half-installed is left behind to be listed as broken.
    expect(readSkills(ws).invalid).toEqual([]);
  });

  it("will not install over a skill that exists, will not pull one that has no repository, and removes", async () => {
    const dir = folder("tidy", { "skill.json": JSON.stringify({ name: "tidy", description: "Tidies.", kind: "script", entry: "run.mjs" }), "run.mjs": "" });
    await installSkill(ws, dir);
    await expect(installSkill(ws, dir)).rejects.toThrow(/already exists/);
    await expect(updateSkill(ws, "tidy")).rejects.toThrow(/not installed from a repository/);
    removeSkill(ws, "tidy");
    expect(readSkills(ws).skills).toEqual([]);
    expect(() => removeSkill(ws, "tidy")).toThrow(/no skill named/);
    expect(() => removeSkill(ws, "../etc")).toThrow(/not a skill name/);
  });

  it("lifts one folder out of a repository of skills, and refetches it to update", async () => {
    /*
     * A collection like anthropics/skills is one repository with a folder
     * per skill. The folder has no .git of its own, so where it came from
     * is written beside it, and an update is a fresh copy.
     */
    const clones: string[][] = [];
    const run = async (file: string, args: string[]): Promise<{ stdout: string }> => {
      if (args[0] === "clone") {
        clones.push([file, ...args]);
        const dest = args[args.length - 1]!;
        mkdirSync(join(dest, "skills", "pdf"), { recursive: true });
        writeFileSync(join(dest, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Read PDFs.\n---\n", "utf8");
        mkdirSync(join(dest, ".git"));
      }
      return { stdout: "" };
    };
    const source = "https://github.com/anthropics/skills/tree/main/skills/pdf";
    const made = await installSkill(ws, source, { run });
    expect(made).toMatchObject({ name: "pdf", dir: "skills/pdf", origin: source });
    expect(clones[0]).toEqual(["git", "clone", "--depth", "1", "--quiet", "--branch", "main", "--", "https://github.com/anthropics/skills.git", expect.any(String)]);
    expect(existsSync(join(root, "skills", "pdf", ".git"))).toBe(false);
    expect(readFileSync(join(root, "skills", "pdf", ".kos-origin"), "utf8").trim()).toBe(source);
    // Nothing of the checkout is left behind.
    expect(existsSync(join(root, "skills", "skills"))).toBe(false);

    const again = await updateSkill(ws, "pdf", { run });
    expect(again.origin).toBe(source);
    expect(clones).toHaveLength(2);
    await expect(installSkill(ws, "https://github.com/anthropics/skills/tree/main/skills/nope", { run })).rejects.toThrow(/not a folder/);
  });

  it("clones a repository through git, then updates it with a pull", async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[], cwd?: string): Promise<{ stdout: string }> => {
      calls.push([file, ...args]);
      if (args[0] === "clone") {
        const dest = args[args.length - 1]!;
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, "SKILL.md"), "---\nname: notes\ndescription: Notes.\n---\n", "utf8");
        mkdirSync(join(dest, ".git"));
      }
      if (args[0] === "remote") return { stdout: "https://github.com/x/kos-notes.git\n" };
      void cwd;
      return { stdout: "" };
    };
    const made = await installSkill(ws, "https://github.com/x/kos-notes.git", { run });
    expect(made).toMatchObject({ name: "notes", origin: "https://github.com/x/kos-notes.git" });
    expect(calls[0]?.slice(0, 3)).toEqual(["git", "clone", "--depth"]);
    const pulled = await updateSkill(ws, "notes", { run });
    expect(pulled.manifest.kind).toBe("prompt");
    expect(calls.some((c) => c[1] === "pull")).toBe(true);
  });
});
