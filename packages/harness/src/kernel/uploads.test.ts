import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { FILE_MAX_BYTES } from "./attachments.js";
import { parseUpload, uploadDir, uploadDirAnywhere, uploadName, writeFileInto, writeProjectFile } from "./uploads.js";

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
      dir: "",
    });
    expect(parseUpload({ name: "a.txt", data: "aGk=", dir: "notes" }).dir).toBe("notes");
    expect(() => parseUpload({ data: "aGk=" })).toThrow(/name/);
    expect(() => parseUpload({ name: "a.txt" })).toThrow(/content/);
    expect(() => parseUpload({ name: "a.txt", data: 7 })).toThrow(/content/);
  });
});

describe("uploadDir", () => {
  it("is the project's folder, or a folder under it", () => {
    expect(uploadDir("budget", "")).toBe("projects/budget");
    expect(uploadDir("budget", ".")).toBe("projects/budget");
    expect(uploadDir("budget", "receipts")).toBe("projects/budget/receipts");
    expect(uploadDir("budget", "receipts/2026/")).toBe("projects/budget/receipts/2026");
    expect(uploadDir("budget", "a/../b")).toBe("projects/budget/b");
  });

  it("refuses a folder that leaves the project, however it is spelled", () => {
    for (const bad of ["..", "../other", "a/../../other", "/etc", "receipts/../../../x", "x\0y"]) {
      expect(() => uploadDir("budget", bad)).toThrow();
    }
    // A sibling project whose slug starts the same way is not inside.
    expect(() => uploadDir("budget", "../budget2")).toThrow(/not inside/);
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
    const written = writeProjectFile(ws, "budget", { name: "receipt.txt", data: b64("milk 4.20"), dir: "" });
    expect(written).toEqual({ path: "projects/budget/receipt.txt", size: 9 });
    expect(readFileSync(join(ws.root, "projects", "budget", "receipt.txt"), "utf8")).toBe("milk 4.20");
  });

  it("puts a file in a folder inside the project when asked to", () => {
    const written = writeProjectFile(ws, "budget", { name: "jan.csv", data: b64("a,b"), dir: "receipts/2026" });
    expect(written).toEqual({ path: "projects/budget/receipts/2026/jan.csv", size: 3 });
    expect(readFileSync(join(ws.root, "projects", "budget", "receipts", "2026", "jan.csv"), "utf8")).toBe("a,b");
    expect(() => writeProjectFile(ws, "budget", { name: "x.txt", data: b64("x"), dir: "../other" })).toThrow(/not inside/);
    expect(existsSync(join(ws.root, "projects", "other"))).toBe(false);
  });

  it("cannot be steered out of the folder by the name", () => {
    writeProjectFile(ws, "budget", { name: "../../escape.txt", data: b64("x"), dir: "" });
    expect(existsSync(join(ws.root, "projects", "budget", "escape.txt"))).toBe(true);
    expect(existsSync(join(ws.root, "escape.txt"))).toBe(false);
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  it("refuses a folder the jail refuses", () => {
    mkdirSync(join(ws.root, "projects"), { recursive: true });
    symlinkSync(tmpdir(), join(ws.root, "projects", "linked"));
    expect(() => writeProjectFile(ws, "linked", { name: "a.txt", data: b64("x"), dir: "" })).toThrow(/symlink/);
  });

  it("takes a 6 MB PDF, which the old 5 MB cap refused", () => {
    const data = Buffer.alloc(6 * 1024 * 1024, 0x25).toString("base64");
    expect(writeProjectFile(ws, "budget", { name: "docs.pdf", data, dir: "" }).size).toBe(6 * 1024 * 1024);
  });

  it("takes a 60 MB scan, which the old 32 MB cap refused", () => {
    const data = Buffer.alloc(60 * 1024 * 1024, 0x25).toString("base64");
    expect(writeProjectFile(ws, "budget", { name: "scan.pdf", data, dir: "" }).size).toBe(60 * 1024 * 1024);
  });

  it("refuses an upload past 100 MB before decoding it, saying why", () => {
    const data = "A".repeat(Math.ceil((FILE_MAX_BYTES + 1024) / 3) * 4);
    expect(() => writeProjectFile(ws, "budget", { name: "big.bin", data, dir: "" })).toThrow(/big\.bin is 100\.0 MB; a file can be up to 100 MB, the most KOS takes of one/);
    expect(existsSync(join(ws.root, "projects", "budget"))).toBe(false);
  });
});

describe("an upload into any folder of the workspace", () => {
  it("lands in the folder named, and refuses the workspace's own files and anything outside", () => {
    expect(uploadDirAnywhere("blobs/recap")).toBe("blobs/recap");
    expect(uploadDirAnywhere("blobs/recap/notes/")).toBe("blobs/recap/notes");
    expect(uploadDirAnywhere("blobs/recap/../watch")).toBe("blobs/watch");
    expect(() => uploadDirAnywhere("")).toThrow(/not a folder/);
    expect(() => uploadDirAnywhere(".")).toThrow(/not a folder/);
    expect(() => uploadDirAnywhere("/etc")).toThrow(/not a folder/);
    expect(() => uploadDirAnywhere("../elsewhere")).toThrow(/not inside/);
    expect(() => uploadDirAnywhere("blobs/../../x")).toThrow(/not inside/);
    expect(() => uploadDirAnywhere(".kos/secrets")).toThrow(/workspace's own/);
    expect(() => uploadDirAnywhere("kos.sqlite")).toThrow(/workspace's own/);
  });

  it("writes the file under the folder, making the folder on the way", () => {
    const root = mkdtempSync(join(tmpdir(), "kos-upload-"));
    const ws = Workspace.open(root);
    try {
      const written = writeFileInto(ws, "blobs/recap/pictures", { name: "../cat.png", data: Buffer.from("png").toString("base64"), dir: "" });
      expect(written).toEqual({ path: "blobs/recap/pictures/cat.png", size: 3 });
      expect(readFileSync(join(root, "blobs", "recap", "pictures", "cat.png"), "utf8")).toBe("png");
    } finally {
      ws.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
