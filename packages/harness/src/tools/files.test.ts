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
import { TEXT_READ_MAX, filesModule, outsideScratch, wholeCharacters } from "./files.js";
import { toPdf } from "./pdf.js";
import { pdfOf } from "../files/pdf.fixture.js";

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

  it("never changes KOS's own settings at the root, which only the owner writes", async () => {
    writeFileSync(join(root, "mcp.json"), '{"servers":{}}');
    writeFileSync(join(root, "notes.txt"), "mine");
    for (const [tool, input] of [
      ["files.write", { path: "mcp.json", content: '{"servers":{"evil":{"command":"node","env":{"K":"{{secret:openai}}"}}}}' }],
      ["files.write", { path: "MCP.json", content: "{}" }],
      ["files.edit", { path: "mcp.json", find: "{}", replace: "{}" }],
      ["files.write", { path: "profile.json", content: "{}" }],
      ["files.cp", { from: "notes.txt", to: "daemon.json" }],
      ["files.mv", { from: "notes.txt", to: "mcp.json" }],
      ["files.rm", { path: "mcp.json" }],
    ] as const) {
      const res = await registry.execute(tool, input);
      expect(res.isError, `${tool} ${JSON.stringify(input)}`).toBe(true);
      expect(res.content).toContain("is KOS's own");
    }
    expect(readFileSync(join(root, "mcp.json"), "utf8")).toBe('{"servers":{}}');
    expect((await registry.execute("files.read", { path: "mcp.json" })).content).toBe('{"servers":{}}');
    expect((await registry.execute("files.write", { path: "sites/mcp.json", content: "{}" })).isError).toBe(false);
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

  it("reads some pages of a long PDF, as a kept 60 MB one is read", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ item: `thing ${i}`, price: String(i) }));
    writeFileSync(join(ws.root, "manual.pdf"), Buffer.from(pdfOf(60 * 1024 * 1024, rows), "base64"));
    const read = await registry.execute("files.read", { path: "manual.pdf", from: 2, to: 3 });
    expect(read.isError).toBe(false);
    expect(read.content).toMatch(/^\[PDF, (\d+) pages, pages 2 to 3\]\n--- page 2 of \1 ---\n/);
    expect(read.content).toContain("--- page 3 of ");
    expect(read.content).not.toMatch(/--- page [14] of /);
    expect((await registry.execute("files.read", { path: "manual.pdf", from: 0 })).content).toMatch(/from must be a page number, from 1/);
    expect((await registry.execute("files.read", { path: "manual.pdf", from: 999 })).content).toMatch(/pages 999 to \d+ are not in it: it has \d+ pages/);
  });

  it("reads a long text file a part at a time, saying where to read on", async () => {
    const lines = Array.from({ length: 30_000 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(ws.root, "server.log"), lines);
    const size = Buffer.byteLength(lines);
    const first = (await registry.execute("files.read", { path: "server.log" })).content;
    expect(first.startsWith(`[text, ${size} bytes, bytes 0 to ${TEXT_READ_MAX}; read on with offset: ${TEXT_READ_MAX}]\nline 0\n`)).toBe(true);
    const part = (await registry.execute("files.read", { path: "server.log", offset: 7, limit: 6 })).content;
    expect(part).toBe(`[text, ${size} bytes, bytes 7 to 13; read on with offset: 13]\nline 1`);
    const last = (await registry.execute("files.read", { path: "server.log", offset: size - 10 })).content;
    expect(last).toBe(`[text, ${size} bytes, bytes ${size - 10} to ${size}]\n${lines.slice(-10)}`);
    expect((await registry.execute("files.read", { path: "server.log", limit: 10 * TEXT_READ_MAX })).content.length).toBeLessThan(TEXT_READ_MAX + 200);
    expect((await registry.execute("files.read", { path: "server.log", offset: -1 })).content).toMatch(/offset must be a byte offset, from 0/);
  });

  it("ends a part of a text file on a whole character", async () => {
    // "naïve": the ï is two bytes, at 2 and 3; a part ending at 3 would split it.
    writeFileSync(join(ws.root, "word.txt"), "naïve");
    const part = (await registry.execute("files.read", { path: "word.txt", offset: 0, limit: 3 })).content;
    expect(part).toBe("[text, 6 bytes, bytes 0 to 2; read on with offset: 2]\nna");
    const rest = (await registry.execute("files.read", { path: "word.txt", offset: 2 })).content;
    expect(rest).toBe("[text, 6 bytes, bytes 2 to 6]\nïve");
    expect(wholeCharacters(Buffer.from("a😀", "utf8").subarray(0, 3))).toEqual(Buffer.from("a"));
    expect(wholeCharacters(Buffer.from("😀", "utf8").subarray(0, 2))).toHaveLength(2);
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

  it("puts a whole folder beyond a chat's Auto, and leaves one file to it", async () => {
    await registry.execute("files.write", { path: "projects/a/one.md", content: "x" });
    expect(registry.classify("files.rm", { path: "projects/a" }).beyondAuto).toBe("deletes a whole folder");
    expect(registry.classify("files.rm", { path: "projects/a/one.md" }).beyondAuto).toBeUndefined();
  });

  it("classifies read/write as safe", () => {
    expect(registry.classify("files.read", { path: "x" }).tier).toBe("safe");
    expect(registry.classify("files.write", { path: "x" }).tier).toBe("safe");
  });

  it("throws JailError directly from resolve for escapes", () => {
    expect(() => ws.resolve("../../etc/passwd")).toThrow(JailError);
  });
});
