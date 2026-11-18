import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";

import { isOffice, officeNote, officeText } from "../files/office.js";
import { PDF_TEXT_MAX, isPdf, pdfText } from "../files/pdftext.js";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { SAFE, type ToolRisk } from "../risk/tiers.js";
import { firstSegment, foldName, isReserved } from "../kernel/files.js";
import { gitControlRefusal } from "../sandbox/githold.js";
import { foldedPath, type Workspace } from "../store/workspace.js";
import { reachOf } from "./sql.js";
import { artifactFileRefusal, artifactFolderRefusal } from "./systems.js";

/**
 * The `files` tool module: primitive, path-gated filesystem operations the agent
 * composes. Every path resolves through the workspace jail, so nothing escapes.
 * Read and write-within-workspace are safe; rm/mv escalate to risky outside the
 * scratch area so destructive moves go through approval.
 */

const SCRATCH_PREFIX = "scratch";

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`missing string arg: ${key}`);
  return v;
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

/** A whole number of at least `least` the caller may give, as `what` says it must be. */
function optInt(input: Record<string, unknown>, key: string, least = 1, what = "a page number, from 1"): number | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < least) throw new Error(`${key} must be ${what}`);
  return v;
}

/** The most of a text file one read hands back, as the most of a PDF's text one read does. */
export const TEXT_READ_MAX = PDF_TEXT_MAX;

/** Bytes `from` up to `to` of a file, read alone. */
function readRange(abs: string, from: number, to: number): Buffer {
  const fd = openSync(abs, "r");
  try {
    const out = Buffer.alloc(Math.max(0, to - from));
    return out.subarray(0, readSync(fd, out, 0, out.byteLength, from));
  } finally {
    closeSync(fd);
  }
}

/**
 * A text file whole when it is small and no part was asked for; otherwise
 * the bytes asked for, at most TEXT_READ_MAX, headed by where they sit in
 * the file and where to read on. Only those bytes are read.
 */
function textRead(abs: string, offset: number | undefined, limit: number | undefined): string {
  if (offset === undefined && limit === undefined) {
    // One byte past the cap says whether there is more, without asking the file system first.
    const head = readRange(abs, 0, TEXT_READ_MAX + 1);
    if (head.byteLength <= TEXT_READ_MAX) return head.toString("utf8");
  }
  const size = statSync(abs).size;
  const from = Math.min(offset ?? 0, size);
  const end = Math.min(size, from + Math.min(limit ?? TEXT_READ_MAX, TEXT_READ_MAX));
  const read = readRange(abs, from, end);
  const bytes = end < size ? wholeCharacters(read) : read;
  const to = from + bytes.byteLength;
  const on = to < size ? `; read on with offset: ${to}` : "";
  return `[text, ${size} bytes, bytes ${from} to ${to}${on}]\n${bytes.toString("utf8")}`;
}

/**
 * The bytes up to the last whole UTF-8 character, so a part cut mid-character
 * ends before it and the next part starts with it. Kept as they are when the
 * part is shorter than the character.
 */
export function wholeCharacters(bytes: Buffer): Buffer {
  // Back over the continuation bytes (10xxxxxx) to the character's first byte.
  let start = bytes.byteLength - 1;
  while (start > 0 && bytes.byteLength - start < 4 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  const lead = bytes[start];
  if (lead === undefined || lead < 0xc0) return bytes;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  if (bytes.byteLength - start >= length || start === 0) return bytes;
  return bytes.subarray(0, start);
}

/** A PDF's text, headed by what was read of it and, when the cap cut it, where to read on. */
async function pdfRead(bytes: Buffer, from: number | undefined, to: number | undefined): Promise<string> {
  const read = await pdfText(new Uint8Array(bytes), undefined, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const whole = read.from === 1 && read.to === read.pages && !read.truncated;
  const pages = `${read.pages} page${read.pages === 1 ? "" : "s"}`;
  const part = whole ? "" : read.from === read.to ? `, page ${read.from}` : `, pages ${read.from} to ${read.to}`;
  const cut = read.next !== undefined ? `, cut short at page ${read.to}; read on with from: ${read.next}` : "";
  return `[PDF, ${pages}${part}${cut}]\n${read.text}`;
}

/** True if a workspace-relative path is outside the scratch area. */
export function outsideScratch(path: string): boolean {
  const norm = path.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return norm !== SCRATCH_PREFIX && !norm.startsWith(`${SCRATCH_PREFIX}/`);
}

const rmRisk: ToolRisk = {
  floor: "safe",
  escalate: (input) => (outsideScratch(optStr(input, "path") ?? "") ? "outside the scratch folder" : false),
};

/** A path under KOS's own state, .kos/, however it is spelled: `.KOS` and `.ko\u017f` are the same folder on a case-insensitive disk. */
export function isKosState(ws: Workspace, path: string): boolean {
  return [foldedPath(ws.root, path), path].some((p) => foldName(firstSegment(p)) === ".kos");
}

/**
 * Why a tool may not write `path`, when it is one of the workspace's own
 * top-level entries (kernel/files.ts RESERVED): KOS's database, its state and
 * its settings, which only the owner changes. A server written into mcp.json
 * would be started with the owner's secrets.
 */
export function reservedRefusal(ws: Workspace, path: string): string | undefined {
  const top = foldName(foldedPath(ws.root, path).split("/")[0] ?? "");
  return isReserved(ws.root, path) ? `${top} is KOS's own, changed only by the owner from the dashboard or the kos command` : undefined;
}

/**
 * A path the file tools may use: anything in the jail but KOS's own state
 * under .kos/, which holds results set aside from other chats and other
 * projects, and is read only through context.recall, which checks whose they are.
 */
function usable(ws: Workspace, path: string): string {
  const abs = ws.resolve(path);
  if (isKosState(ws, relative(ws.root, abs))) throw new Error(".kos is KOS's own state and is not read or changed with files.*; a result set aside in this chat comes back with context.recall");
  return abs;
}

function defineFileTools(ws: Workspace, ctx: ModuleContext): void {
  /**
   * An artifact's file, version or capture is reached as the artifacts tools
   * reach it: by its owner's chats, and then only to read. Its document,
   * versions and captures are never given new content here (`replace`: a
   * write, an edit, a copy or move onto one), which would skip every check a
   * write makes and keep no version; and none is taken away (`remove`: an rm,
   * or a move from it or a folder holding it), which is the owner's to do
   * from the trash.
   */
  const fenced = (path: string, what: "read" | "replace" | "remove", folder = false): string => {
    const abs = usable(ws, path);
    const reserved = what === "read" ? undefined : reservedRefusal(ws, relative(ws.root, abs));
    if (reserved) throw new Error(reserved);
    // A repository's config or hooks name programs a git read would run.
    const git = what === "replace" ? gitControlRefusal(foldedPath(ws.root, path)) : undefined;
    if (git) throw new Error(git);
    const pages = ctx.services?.pages;
    if (!pages) return abs;
    const rel = relative(ws.root, abs);
    const reach = reachOf(ctx);
    const as = what === "read" ? "read" : "change";
    // A folder taken whole (rm, mv, cp) takes every artifact under it, so each one's owner must be this chat's to reach.
    const whole = what === "remove" || folder;
    const why = artifactFileRefusal(pages, rel, reach, as) ?? (whole ? artifactFolderRefusal(pages, rel, reach, as) : undefined);
    if (why) throw new Error(why);
    if (what === "read") return abs;
    const record = pages.recordAt(rel);
    if (record && what === "replace") {
      throw new Error(`${rel} is part of the artifact ${record.id}, which files.* does not change: change part of it with artifacts.patch, or all of it with artifacts.write, so it is checked and kept as a version`);
    }
    const held = record ?? (what === "remove" ? pages.recordsUnder(rel)[0] : undefined);
    if (held) {
      throw new Error(`${rel} ${record ? "is part of" : "holds"} the artifact ${held.id}, which files.* does not take away: KOS never deletes an artifact; the owner puts one in the trash from the Artifacts page. To give it another owner, use artifacts.move`);
    }
    return abs;
  };
  ctx.registerTool(
    {
      name: "files.read",
      description: `Read a file from the workspace: UTF-8 text as it is, or part of it (offset and limit, in bytes; at most ${TEXT_READ_MAX} bytes a read, so a long file is read a part at a time); a PDF as its text page by page (from and to read some of its pages, as a long one is read); a Word, Excel or PowerPoint file (.docx, .xlsx, .pptx) as its paragraphs, rows or slides.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          from: { type: "integer", minimum: 1, description: "A PDF's first page to read." },
          to: { type: "integer", minimum: 1, description: "A PDF's last page to read." },
          offset: { type: "integer", minimum: 0, description: "A text file's first byte to read." },
          limit: { type: "integer", minimum: 1, description: "How many bytes of a text file to read." },
        },
        required: ["path"],
      },
    },
    async (input) => {
      const abs = fenced(str(input, "path"), "read");
      // Its head says what it is; a text file is then read only as far as asked, however long it is.
      const head = readRange(abs, 0, 8);
      if (isPdf(head) || isOffice(head, abs)) {
        const bytes = readFileSync(abs);
        if (isPdf(bytes)) return pdfRead(bytes, optInt(input, "from"), optInt(input, "to"));
        const read = officeText(new Uint8Array(bytes), abs);
        return `[${officeNote(read)}]\n${read.text}`;
      }
      return textRead(abs, optInt(input, "offset", 0, "a byte offset, from 0"), optInt(input, "limit", 1, "a number of bytes, from 1"));
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "files.write",
      description: "Write (overwrite) a UTF-8 file in the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    (input) => {
      const abs = fenced(str(input, "path"), "replace");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, str(input, "content"));
      return "ok";
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "files.edit",
      description: "Replace the first occurrence of a string in a workspace file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
        },
        required: ["path", "find", "replace"],
      },
    },
    (input) => {
      const abs = fenced(str(input, "path"), "replace");
      const before = readFileSync(abs, "utf8");
      const find = str(input, "find");
      if (!before.includes(find)) throw new Error("find string not present");
      writeFileSync(abs, before.replace(find, str(input, "replace")));
      return "ok";
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "files.ls",
      description: "List entries in a workspace directory.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
    (input) => {
      const abs = usable(ws, optStr(input, "path") ?? ".");
      return readdirSync(abs)
        .map((name) => {
          const s = statSync(ws.resolve(`${optStr(input, "path") ?? "."}/${name}`));
          return s.isDirectory() ? `${name}/` : name;
        })
        .join("\n");
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "files.mkdir",
      description: "Create a directory (and parents) in the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    (input) => {
      mkdirSync(ws.resolve(str(input, "path")), { recursive: true });
      return "ok";
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "files.cp",
      description: "Copy a file within the workspace.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
    (input) => {
      const to = fenced(str(input, "to"), "replace");
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(fenced(str(input, "from"), "read", true), to);
      return "ok";
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "files.mv",
      description: "Move or rename a file within the workspace.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
    (input) => {
      const to = fenced(str(input, "to"), "replace");
      // Moved out, a repository's config is changed where it lands and moved back as something else.
      const fromGit = gitControlRefusal(foldedPath(ws.root, str(input, "from")));
      if (fromGit) throw new Error(fromGit);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(fenced(str(input, "from"), "remove"), to);
      return "ok";
    },
    { floor: "safe", escalate: (input) => (outsideScratch(optStr(input, "from") ?? "") ? "outside the scratch folder" : false) },
  );

  ctx.registerTool(
    {
      name: "files.rm",
      description: "Delete a file or directory in the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    (input) => {
      rmSync(fenced(str(input, "path"), "remove"), { recursive: true, force: true });
      return "ok";
    },
    rmRisk,
  );
}

export const filesModule: KosModule = {
  manifest: {
    name: "files",
    version: "1.0.0",
    provides: [
      { kind: "tool", name: "files.read", version: "1.0.0" },
      { kind: "tool", name: "files.write", version: "1.0.0" },
      { kind: "tool", name: "files.edit", version: "1.0.0" },
      { kind: "tool", name: "files.ls", version: "1.0.0" },
      { kind: "tool", name: "files.mkdir", version: "1.0.0" },
      { kind: "tool", name: "files.cp", version: "1.0.0" },
      { kind: "tool", name: "files.mv", version: "1.0.0" },
      { kind: "tool", name: "files.rm", version: "1.0.0" },
    ],
    riskTier: "safe",
  },
  activate(ctx) {
    const { workspace } = requireServices(ctx);
    defineFileTools(workspace, ctx);
  },
};
