import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { MAX_UPLOAD_BYTES, parseUpload, uploadName, writeProjectFile } from "./uploads.js";

const b64 = (text: string): string => Buffer.from(text).toString("base64");

describe("uploadName", () => {
  it("keeps only the last segment, whichever slash was used", () => {
    expect(uploadName("notes.md")).toBe("notes.md");
    expect(uploadName("../../etc/passwd")).toBe("passwd");
    expect(uploadName("a/b/c.png")).toBe("c.png");
    expect(uploadName("a\\b\\c.png")).toBe("c.png");
    expect(uploadName("/abs/path.txt")).toBe("path.txt");
  });

  it("refuses a name that is no file at all", () => {
    for (const bad of ["", "   ", ".", "..", "a/..", "/", "x\0y"]) {
      expect(() => uploadName(bad)).toThrow();
    }
  });
});

describe("parseUpload", () => {
  it("takes a name and a payload and nothing less", () => {
    expect(parseUpload({ name: "a.txt", data: "aGk=", mediaType: "text/plain" })).toEqual({
      name: "a.txt",
      data: "aGk=",
    });
    expect(() => parseUpload({ data: "aGk=" })).toThrow(/name/);
    expect(() => parseUpload({ name: "a.txt" })).toThrow(/content/);
    expect(() => parseUpload({ name: "a.txt", data: 7 })).toThrow(/content/);
  });
});

describe("writeProjectFile", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-upload-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the decoded bytes into the project's folder, making it if need be", () => {
    const written = writeProjectFile(ws, "budget", { name: "receipt.txt", data: b64("milk 4.20") });
    expect(written).toEqual({ path: "projects/budget/receipt.txt", size: 9 });
    expect(readFileSync(join(ws.root, "projects", "budget", "receipt.txt"), "utf8")).toBe("milk 4.20");
  });

  it("cannot be steered out of the folder by the name", () => {
    writeProjectFile(ws, "budget", { name: "../../escape.txt", data: b64("x") });
    expect(existsSync(join(ws.root, "projects", "budget", "escape.txt"))).toBe(true);
    expect(existsSync(join(ws.root, "escape.txt"))).toBe(false);
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  it("refuses a folder the jail refuses", () => {
    mkdirSync(join(ws.root, "projects"), { recursive: true });
    symlinkSync(tmpdir(), join(ws.root, "projects", "linked"));
    expect(() => writeProjectFile(ws, "linked", { name: "a.txt", data: b64("x") })).toThrow(/symlink/);
  });

  it("refuses an upload past the cap before decoding it", () => {
    const data = "A".repeat(Math.ceil((MAX_UPLOAD_BYTES + 1024) / 3) * 4);
    expect(() => writeProjectFile(ws, "budget", { name: "big.bin", data })).toThrow(/limit is 5MB/);
    expect(existsSync(join(ws.root, "projects", "budget"))).toBe(false);
  });
});
