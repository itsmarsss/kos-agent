import {
  closeSync,
  copyFileSync,
  existsSync,
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
import { dirname } from "node:path";

import { LAYOUT_FOLDERS, placePath } from "@kos/shared";

import { isOffice, officeNote, officeText } from "../files/office.js";
import { PDF_TEXT_MAX, isPdf, pdfText } from "../files/pdftext.js";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { firstSegment, foldName, isReserved } from "../kernel/files.js";
import { SAFE, type Escalation, type ToolRisk } from "../risk/tiers.js";
import { gitControlRefusal } from "../sandbox/githold.js";
import { foldedPath, type Workspace } from "../store/workspace.js";
import { callerHome, placeFor, reachOutside, type HomePath } from "./home.js";
import { maintains, type Reach } from "./fence.js";
import { reachOf } from "./sql.js";
import { artifactFileRefusal, artifactFolderRefusal } from "./systems.js";

/**
 * The `files` tool module: primitive, path-gated filesystem operations the agent
 * composes. A relative path starts from the calling turn's home folder (its
 * project's, its blob's, or the root; see tools/home.ts), and every path then
 * resolves through the workspace jail, so nothing escapes. Read and write in
 * the home are safe; a change outside it asks; rm/mv escalate to risky outside
 * the scratch area so destructive moves go through approval.
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

/** Whether a path is there now, placed as the call places it; a path the jail refuses is not. */
function exists(ws: Workspace, ctx: ModuleContext, path: string): boolean {
  try {
    return path !== "" && existsSync(placeFor(ws, ctx, path).abs);
  } catch {
    return false;
  }
}

/** Whether a path is a folder now, placed as the call places it; a path the jail refuses is no folder of its own. */
function isFolder(ws: Workspace, ctx: ModuleContext, path: string): boolean {
  try {
    return path !== "" && statSync(placeFor(ws, ctx, path).abs).isDirectory();
  } catch {
    return false;
  }
}

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
 * Why a tool may not read `path`, when it is one of the workspace's own
 * top-level entries: KOS's database and its journals hold every project's
 * tables, the transcripts and the trust tables, past the sql fence, and its
 * settings and locks are KOS's own. Maintenance, which repairs KOS, may read
 * them, as it may query KOS's tables; .kos stays refused to it too, as every
 * file tool refuses it.
 */
export function reservedReadRefusal(ws: Workspace, path: string, reach: Reach): string | undefined {
  if (!isReserved(ws.root, path)) return undefined;
  if (maintains(reach) && !isKosState(ws, path)) return undefined;
  const top = foldName(foldedPath(ws.root, path).split("/")[0] ?? "");
  return `${top} is KOS's own, not read with the file tools: a project's tables are read through sql, jobs through cron.list, chats through chats.list and chats.read, memory through memory.recall`;
}

/**
 * Why a removal or a move may not take `rel` whole: the workspace itself,
 * one of KOS's own top-level folders, or a project's or a blob's folder,
 * which a project's or a blob's own tools remove. What is inside them is
 * the chat's to manage.
 */
export function layoutRefusal(rel: string): string | undefined {
  const parts = foldName(rel).split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return "the workspace itself cannot be moved or removed";
  if (parts.length === 1 && LAYOUT_FOLDERS.includes(parts[0]!)) return `${rel} is part of the workspace's layout; manage what is inside it`;
  if (parts.length === 2 && (parts[0] === "projects" || parts[0] === "blobs")) {
    return `${rel} is ${parts[0] === "projects" ? "a project's" : "a blob's"} own folder, not moved or removed with files.*; manage what is inside it`;
  }
  return undefined;
}

/** The paths relative paths start from and what reaching outside them means, said once for every tool. */
const HOME_PATHS =
  "A relative path is inside your own folder (your project's folder in a project's chats); workspace:<path> is from the workspace root, as is a path starting with projects/, blobs/, skills/ or scratch/. Changing anything outside your own folder asks the owner.";

/**
 * A path the file tools may use, placed from the calling turn's home:
 * anything in the jail but KOS's own state under .kos/, which holds results
 * set aside from other chats and other projects, and is read only through
 * context.recall, which checks whose they are.
 */
function usable(ws: Workspace, ctx: ModuleContext, path: string): HomePath {
  const placed = placeFor(ws, ctx, path);
  if (isKosState(ws, placed.rel)) throw new Error(".kos is KOS's own state and is not read or changed with files.*; a result set aside in this chat comes back with context.recall");
  return placed;
}

function defineFileTools(ws: Workspace, ctx: ModuleContext): void {
  /** The paths a call changes, for the reach rule: asks when one is outside the turn's home. */
  const changing = (...keys: string[]): ToolRisk["reach"] => reachOutside(ws, ctx, (input) => keys.map((k) => input[k]));
  /** Asks for a removal outside the scratch area, judged where the path lands. */
  const scratchOnly = (key: string): Escalation => (input) =>
    outsideScratch(placePath(callerHome(ctx), optStr(input, key) ?? "", ws.root).path) ? "outside the scratch folder" : false;
  /**
   * An artifact's file, version or capture is reached as the artifacts tools
   * reach it: by its owner's chats, and then only to read. Its document,
   * versions and captures are never given new content here (`replace`: a
   * write, an edit, a copy or move onto one), which would skip every check a
   * write makes and keep no version; and none is taken away (`remove`: an rm,
   * or a move from it or a folder holding it), which is the owner's to do
   * from the trash.
   */
  const fenced = (path: string, what: "read" | "replace" | "remove", folder = false): HomePath => {
    const placed = usable(ws, ctx, path);
    const reserved = what === "read" ? reservedReadRefusal(ws, placed.rel, reachOf(ctx)) : reservedRefusal(ws, placed.rel);
    if (reserved) throw new Error(reserved);
    // A repository's config or hooks name programs a git read would run.
    const git = what === "replace" ? gitControlRefusal(foldedPath(ws.root, placed.rel)) : undefined;
    if (git) throw new Error(git);
    // Said after the artifacts' own refusals, which name what a folder holds.
    const laidOut = (): HomePath => {
      const refused = what === "remove" ? layoutRefusal(placed.rel) : undefined;
      if (refused) throw new Error(refused);
      return placed;
    };
    const pages = ctx.services?.pages;
    if (!pages) return laidOut();
    const { rel } = placed;
    const reach = reachOf(ctx);
    const as = what === "read" ? "read" : "change";
    // A folder taken whole (rm, mv, cp) takes every artifact under it, so each one's owner must be this chat's to reach.
    const whole = what === "remove" || folder;
    const why = artifactFileRefusal(pages, rel, reach, as) ?? (whole ? artifactFolderRefusal(pages, rel, reach, as) : undefined);
    if (why) throw new Error(why);
    if (what === "read") return placed;
    const record = pages.recordAt(rel);
    if (record && what === "replace") {
      throw new Error(`${rel} is part of the artifact ${record.id}, which files.* does not change: change part of it with artifacts.patch, or all of it with artifacts.write, so it is checked and kept as a version`);
    }
    const held = record ?? (what === "remove" ? pages.recordsUnder(rel)[0] : undefined);
    if (held) {
      throw new Error(`${rel} ${record ? "is part of" : "holds"} the artifact ${held.id}, which files.* does not take away: KOS never deletes an artifact; the owner puts one in the trash from the Artifacts page. To give it another owner, use artifacts.move`);
    }
    return laidOut();
  };
  ctx.registerTool(
    {
      name: "files.read",
      description: `Read a file from the workspace: UTF-8 text as it is, or part of it (offset and limit, in bytes; at most ${TEXT_READ_MAX} bytes a read, so a long file is read a part at a time); a PDF as its text page by page (from and to read some of its pages, as a long one is read); a Word, Excel or PowerPoint file (.docx, .xlsx, .pptx) as its paragraphs, rows or slides. ${HOME_PATHS} Reading anywhere is fine but KOS's own database, state and settings at the workspace root.`,
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
      const { abs } = fenced(str(input, "path"), "read");
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
      description: `Write (overwrite) a UTF-8 file. ${HOME_PATHS} The result names the file by its workspace path.`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    (input) => {
      const { abs, rel } = fenced(str(input, "path"), "replace");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, str(input, "content"));
      return `wrote ${rel}`;
    },
    { floor: "safe", reach: changing("path") },
  );

  ctx.registerTool(
    {
      name: "files.edit",
      description: `Replace the first occurrence of a string in a file. ${HOME_PATHS}`,
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
      const { abs, rel } = fenced(str(input, "path"), "replace");
      const before = readFileSync(abs, "utf8");
      const find = str(input, "find");
      if (!before.includes(find)) throw new Error("find string not present");
      writeFileSync(abs, before.replace(find, str(input, "replace")));
      return `edited ${rel}`;
    },
    { floor: "safe", reach: changing("path") },
  );

  ctx.registerTool(
    {
      name: "files.ls",
      description: `List entries in a directory; with no path, your own folder. ${HOME_PATHS}`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
    (input) => {
      const { abs, rel } = usable(ws, ctx, optStr(input, "path") ?? ".");
      const reserved = reservedReadRefusal(ws, rel, reachOf(ctx));
      if (reserved) throw new Error(reserved);
      return readdirSync(abs)
        .map((name) => {
          const s = statSync(ws.resolve(rel ? `${rel}/${name}` : name));
          return s.isDirectory() ? `${name}/` : name;
        })
        .join("\n");
    },
    SAFE,
  );

  ctx.registerTool(
    {
      name: "files.mkdir",
      description: `Create a directory (and parents). ${HOME_PATHS}`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    (input) => {
      const { abs, rel } = fenced(str(input, "path"), "replace");
      mkdirSync(abs, { recursive: true });
      return `made ${rel}/`;
    },
    { floor: "safe", reach: changing("path") },
  );

  ctx.registerTool(
    {
      name: "files.cp",
      description: `Copy a file. ${HOME_PATHS}`,
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
    (input) => {
      const to = fenced(str(input, "to"), "replace");
      mkdirSync(dirname(to.abs), { recursive: true });
      copyFileSync(fenced(str(input, "from"), "read", true).abs, to.abs);
      return `copied to ${to.rel}`;
    },
    { floor: "safe", reach: changing("to") },
  );

  ctx.registerTool(
    {
      name: "files.mv",
      description: `Move or rename a file. ${HOME_PATHS}`,
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
    (input) => {
      const to = fenced(str(input, "to"), "replace");
      // Nothing is moved onto the workspace, KOS's own folders, or a project's or a blob's folder itself.
      const onto = layoutRefusal(to.rel);
      if (onto) throw new Error(onto);
      const from = fenced(str(input, "from"), "remove");
      // Moved out, a repository's config is changed where it lands and moved back as something else.
      const fromGit = gitControlRefusal(foldedPath(ws.root, from.rel));
      if (fromGit) throw new Error(fromGit);
      mkdirSync(dirname(to.abs), { recursive: true });
      renameSync(from.abs, to.abs);
      return `moved to ${to.rel}`;
    },
    {
      floor: "safe",
      escalate: scratchOnly("from"),
      reach: changing("from", "to"),
      // A move onto a file that is there already replaces it: the owner's to allow, whatever the chat is set to.
      beyondAuto: (input) => (exists(ws, ctx, optStr(input, "to") ?? "") ? "replaces a file that is there" : false),
    },
  );

  ctx.registerTool(
    {
      name: "files.rm",
      description: `Delete a file or directory. ${HOME_PATHS}`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    (input) => {
      const { abs, rel } = fenced(str(input, "path"), "remove");
      rmSync(abs, { recursive: true, force: true });
      return `removed ${rel}`;
    },
    {
      floor: "safe",
      escalate: scratchOnly("path"),
      reach: changing("path"),
      // One file is covered by a chat's Auto; a whole folder at once never is.
      beyondAuto: (input) => (isFolder(ws, ctx, optStr(input, "path") ?? "") ? "deletes a whole folder" : false),
    },
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
