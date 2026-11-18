import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROOT_HOME, type FileHome } from "@kos/shared";

import { ToolRegistry } from "../agent/registry.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { exportModule } from "./export.js";
import { filesModule } from "./files.js";
import { createPythonModule } from "./python.js";
import { createShellModule } from "./shell.js";

const onMac = process.platform === "darwin";

/**
 * File tools as a turn with a home calls them. The home and the project are
 * what the kernel's services would say for the calling conversation.
 */
describe("a turn's file home", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;
  let home: FileHome;
  let project: string | undefined;

  beforeEach(async () => {
    // Under the real home directory, where the macOS jail carves the workspace back out.
    root = mkdtempSync(join(homedir(), ".kos-home-test-"));
    ws = Workspace.open(root);
    home = { folder: "projects/school" };
    project = "school";
    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
      callerHome: () => home,
      callerProject: () => project,
    });
    await new ModuleLoader(ctx).load([filesModule, exportModule, createShellModule({ timeoutSeconds: 5 }), createPythonModule()]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const write = (path: string) => registry.execute("files.write", { path, content: "x" });
  const exists = (path: string) => existsSync(join(root, path));

  it("puts a relative path from a project inside the project, and says where", async () => {
    const res = await write("bu252/mokable/doc.md");
    expect(res).toMatchObject({ isError: false, content: "wrote projects/school/bu252/mokable/doc.md" });
    expect(exists("projects/school/bu252/mokable/doc.md")).toBe(true);
    expect(exists("bu252")).toBe(false);
  });

  it("puts a path that starts with the project's own name inside the project", async () => {
    await write("school/bu252/x.md");
    expect(exists("projects/school/bu252/x.md")).toBe(true);
    expect(exists("school")).toBe(false);
  });

  it("does not double a path written from the root", async () => {
    await write("projects/school/x.md");
    expect(exists("projects/school/x.md")).toBe(true);
    expect(exists("projects/school/projects")).toBe(false);
  });

  it("lists, makes, copies, moves and removes inside the home", async () => {
    await write("a.md");
    expect((await registry.execute("files.mkdir", { path: "drafts" })).content).toBe("made projects/school/drafts/");
    expect((await registry.execute("files.cp", { from: "a.md", to: "drafts/b.md" })).content).toBe("copied to projects/school/drafts/b.md");
    expect((await registry.execute("files.mv", { from: "drafts/b.md", to: "drafts/c.md" })).content).toBe("moved to projects/school/drafts/c.md");
    expect((await registry.execute("files.ls", {})).content.split("\n").sort()).toEqual(["a.md", "drafts/"]);
    expect((await registry.execute("files.ls", { path: "drafts" })).content).toBe("c.md");
    expect((await registry.execute("files.read", { path: "drafts/c.md" })).content).toBe("x");
    expect((await registry.execute("files.rm", { path: "drafts/c.md" })).content).toBe("removed projects/school/drafts/c.md");
  });

  it("writes inside the home without asking", () => {
    for (const [tool, input] of [
      ["files.write", { path: "x.md" }],
      ["files.write", { path: "school/x.md" }],
      ["files.write", { path: "projects/school/x.md" }],
      ["files.mkdir", { path: "drafts" }],
      ["files.cp", { from: "projects/resume/cv.md", to: "cv.md" }],
      ["export.query", { path: "out.csv" }],
    ] as const) {
      expect(registry.classify(tool, input), `${tool} ${JSON.stringify(input)}`).toEqual({ tier: "safe", escalated: false });
    }
  });

  it("reaches the root with workspace:, and a write there asks, outside this project", async () => {
    expect(registry.classify("files.write", { path: "workspace:notes/x.md" })).toEqual({
      tier: "risky",
      escalated: true,
      reason: "outside this project, in notes/",
      reached: true,
    });
    // Once allowed, it lands where it was written.
    await write("workspace:notes/x.md");
    expect(exists("notes/x.md")).toBe(true);
    expect(exists("projects/school/notes")).toBe(false);
  });

  it("names another project's folder when a change lands in it, and keeps that beyond Auto", () => {
    for (const [tool, input] of [
      ["files.write", { path: "projects/resume/cv.md" }],
      ["files.edit", { path: "workspace:projects/resume/cv.md" }],
      ["files.mkdir", { path: "projects/resume/old" }],
      ["files.cp", { from: "a.md", to: "projects/resume/a.md" }],
      ["export.query", { path: "projects/resume/out.csv" }],
    ] as const) {
      const judged = registry.classify(tool, input);
      expect(judged.tier, tool).toBe("risky");
      expect(judged.reason, tool).toBe("outside this project, in the resume project");
      expect(judged.beyondAuto, tool).toBe("writes into another project");
    }
    expect(registry.classify("files.write", { path: "blobs/noter/x.md" }).beyondAuto).toBe("writes into another project");
    // A file kept at the workspace root is still Auto's to allow.
    expect(registry.classify("files.write", { path: "workspace:notes/x.md" }).beyondAuto).toBeUndefined();
  });

  it("keeps a removal's own reason and adds where it reaches", () => {
    expect(registry.classify("files.rm", { path: "projects/resume/cv.md" })).toEqual({
      tier: "risky",
      escalated: true,
      reason: "outside the scratch folder, outside this project, in the resume project",
      reached: true,
      beyondAuto: "writes into another project",
    });
    expect(registry.classify("files.rm", { path: "old.md" })).toEqual({ tier: "risky", escalated: true, reason: "outside the scratch folder" });
    expect(registry.classify("files.mv", { from: "a.md", to: "workspace:a.md" }).reason).toBe("outside the scratch folder, outside this project, in the workspace root");
  });

  it("reads outside the home without asking", async () => {
    mkdirSync(join(root, "projects", "resume"), { recursive: true });
    writeFileSync(join(root, "projects", "resume", "cv.md"), "resume");
    expect(registry.classify("files.read", { path: "projects/resume/cv.md" }).tier).toBe("safe");
    expect((await registry.execute("files.read", { path: "projects/resume/cv.md" })).content).toBe("resume");
    expect((await registry.execute("files.ls", { path: "workspace:projects" })).content).toBe("resume/");
  });

  it("lets Maintenance change anything without the reach asking, as the root does", () => {
    home = { folder: "projects/maintenance" };
    project = "maintenance";
    expect(registry.classify("files.write", { path: "workspace:skills/pdf/notes.md" })).toEqual({ tier: "safe", escalated: false });
  });

  it("leaves a root chat's paths as they always were", async () => {
    home = ROOT_HOME;
    project = undefined;
    await write("school/x.md");
    expect(exists("school/x.md")).toBe(true);
    expect(registry.classify("files.write", { path: "projects/resume/cv.md" })).toEqual({ tier: "safe", escalated: false });
  });

  it("still refuses a path that leaves the workspace", async () => {
    expect((await write("../escape.md")).isError).toBe(true);
    expect((await write("workspace:../escape.md")).isError).toBe(true);
    expect((await write("/etc/kos-escape.md")).isError).toBe(true);
  });

  it("never removes or moves the workspace, its own folders, or a project's or a blob's folder itself", async () => {
    mkdirSync(join(root, "projects", "school"), { recursive: true });
    mkdirSync(join(root, "projects", "resume"), { recursive: true });
    for (const [tool, input] of [
      ["files.rm", { path: "." }],
      ["files.rm", { path: "school" }],
      ["files.rm", { path: "workspace:" }],
      ["files.rm", { path: "workspace:projects/resume" }],
      ["files.rm", { path: "workspace:Projects" }],
      ["files.mv", { from: ".", to: "workspace:old-school" }],
      ["files.mv", { from: "workspace:blobs/noter", to: "x" }],
    ] as const) {
      const res = await registry.execute(tool, input);
      expect(res.isError, `${tool} ${JSON.stringify(input)}`).toBe(true);
      expect(res.content).toMatch(/workspace itself|own folder|layout/);
    }
    expect(existsSync(join(root, "projects", "school"))).toBe(true);
    expect(existsSync(join(root, "projects", "resume"))).toBe(true);
  });

  it("keeps KOS's own files out of reach of writes, from a project and from the root", async () => {
    for (const at of [home, ROOT_HOME]) {
      home = at;
      for (const [tool, input] of [
        ["files.write", { path: "workspace:mcp.json", content: "{}" }],
        ["files.write", { path: "workspace:profile.json", content: "{}" }],
        ["files.mkdir", { path: "workspace:locks/x" }],
        ["files.rm", { path: "workspace:kos.sqlite" }],
        ["export.query", { query: "SELECT 1 AS n", path: "workspace:mcp.json", format: "json" }],
      ] as const) {
        const res = await registry.execute(tool, input);
        expect(res.isError, `${at.folder} ${tool} ${JSON.stringify(input)}`).toBe(true);
        expect(res.content).toContain("is KOS's own");
      }
    }
    expect(existsSync(join(root, "mcp.json"))).toBe(false);
    expect(existsSync(join(root, "kos.sqlite"))).toBe(true);
  });

  it.runIf(onMac)("starts the shell in the home, and runs it elsewhere on purpose", async () => {
    const pwd = async (input: Record<string, unknown>) => JSON.parse((await registry.execute("shell.run", { command: "pwd", ...input })).content) as { stdout: string };
    expect((await pwd({})).stdout.trim()).toBe(realpathSync(join(root, "projects", "school")));
    mkdirSync(join(root, "notes"));
    expect((await pwd({ cwd: "workspace:notes" })).stdout.trim()).toBe(realpathSync(join(root, "notes")));
    expect(registry.classify("shell.run", { command: "touch a", cwd: "workspace:notes" }).reason).toBe("a command that may write, outside this project, in the workspace root");
  });

  it.runIf(onMac)("starts Python in the home", async () => {
    writeFileSync(join(root, "top.txt"), "at the root");
    const res = await registry.execute("python.run", { code: "import os\nprint(os.getcwd())\nprint(open(os.path.expanduser('~/top.txt')).read())" });
    const [cwd, top] = (JSON.parse(res.content) as { stdout: string }).stdout.trim().split("\n");
    expect(cwd).toBe(realpathSync(join(root, "projects", "school")));
    expect(top).toBe("at the root");
  });

  it("exports into the home and names the file by its workspace path", async () => {
    const res = await registry.execute("export.query", { query: "SELECT 1 AS n", path: "out.csv", format: "csv" });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content)).toMatchObject({ path: "projects/school/out.csv" });
    expect(readFileSync(join(root, "projects", "school", "out.csv"), "utf8")).toContain("n");
  });
});
