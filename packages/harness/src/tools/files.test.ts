import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { JailError } from "../jail/resolvePath.js";
import { ModuleLoader, toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { filesModule, outsideScratch } from "./files.js";
import { toPdf } from "./pdf.js";

describe("outsideScratch", () => {
  it("recognizes the scratch area", () => {
    expect(outsideScratch("scratch/tmp.txt")).toBe(false);
    expect(outsideScratch("scratch")).toBe(false);
    expect(outsideScratch("projects/data.txt")).toBe(true);
    expect(outsideScratch("scratchpad/x")).toBe(true);
  });
});

describe("filesModule", () => {
  let root: string;
  let ws: Workspace;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-files-"));
    ws = Workspace.open(root);
    registry = new ToolRegistry();
    const ctx = toolRegistryContext(registry, {
      workspace: ws,
      db: ws.db,
      secrets: new SecretsRegistry(),
    });
    await new ModuleLoader(ctx).load([filesModule]);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves .kos alone: results set aside there are read only through context.recall", async () => {
    mkdirSync(join(root, ".kos", "results"), { recursive: true });
    writeFileSync(join(root, ".kos", "results", "r_00000000.json"), "{}");
    writeFileSync(join(root, "notes.txt"), "mine");
    for (const [tool, input] of [
      ["files.read", { path: ".kos/results/r_00000000.json" }],
      ["files.ls", { path: ".kos/results" }],
      ["files.cp", { from: ".kos/results/r_00000000.json", to: "copy.json" }],
      ["files.cp", { from: "notes.txt", to: ".kos/results/notes.txt" }],
      ["files.mv", { from: ".kos/results/r_00000000.json", to: "moved.json" }],
      ["files.mv", { from: "notes.txt", to: ".kos/notes.txt" }],
    ] as const) {
      const res = await registry.execute(tool, input);
      expect(res.isError, `${tool} ${JSON.stringify(input)}`).toBe(true);
      expect(res.content).toContain(".kos is KOS's own state");
    }
    expect(existsSync(join(root, "copy.json"))).toBe(false);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
  });

  it("registers all file tools", () => {
    for (const t of ["read", "write", "edit", "ls", "mkdir", "cp", "mv", "rm"]) {
      expect(registry.has(`files.${t}`)).toBe(true);
    }
  });

  it("writes and reads a file through the jail", async () => {
    expect((await registry.execute("files.write", { path: "a/b.txt", content: "hi" })).isError).toBe(false);
    const read = await registry.execute("files.read", { path: "a/b.txt" });
    expect(read.content).toBe("hi");
    expect(existsSync(join(ws.root, "a", "b.txt"))).toBe(true);
  });

  it("reads a PDF as its words", async () => {
    writeFileSync(join(ws.root, "doc.pdf"), toPdf([{ item: "kettle", price: "42" }], "Shopping"));
    const read = await registry.execute("files.read", { path: "doc.pdf" });
    expect(read.isError).toBe(false);
    expect(read.content.startsWith("[PDF, 1 page]\n")).toBe(true);
    expect(read.content).toContain("kettle 42");
  });

  it("edits a file by string replacement", async () => {
    writeFileSync(join(ws.root, "f.txt"), "hello world");
    await registry.execute("files.edit", { path: "f.txt", find: "world", replace: "kos" });
    expect(readFileSync(join(ws.root, "f.txt"), "utf8")).toBe("hello kos");
  });

  it("copies, moves, and lists", async () => {
    await registry.execute("files.write", { path: "scratch/x.txt", content: "1" });
    await registry.execute("files.cp", { from: "scratch/x.txt", to: "scratch/y.txt" });
    await registry.execute("files.mv", { from: "scratch/y.txt", to: "scratch/z.txt" });
    const ls = await registry.execute("files.ls", { path: "scratch" });
    expect(ls.content.split("\n").sort()).toEqual(["x.txt", "z.txt"]);
  });

  it("removes a file", async () => {
    await registry.execute("files.write", { path: "scratch/del.txt", content: "x" });
    await registry.execute("files.rm", { path: "scratch/del.txt" });
    expect(existsSync(join(ws.root, "scratch", "del.txt"))).toBe(false);
  });

  it("rejects a path that escapes the workspace", async () => {
    const res = await registry.execute("files.read", { path: "../escape" });
    expect(res.isError).toBe(true);
  });

  it("classifies rm: safe in scratch, risky outside", () => {
    expect(registry.classify("files.rm", { path: "scratch/x" }).tier).toBe("safe");
    expect(registry.classify("files.rm", { path: "projects/x" }).tier).toBe("risky");
  });

  it("classifies read/write as safe", () => {
    expect(registry.classify("files.read", { path: "x" }).tier).toBe("safe");
    expect(registry.classify("files.write", { path: "x" }).tier).toBe("safe");
  });

  it("throws JailError directly from resolve for escapes", () => {
    expect(() => ws.resolve("../../etc/passwd")).toThrow(JailError);
  });
});
