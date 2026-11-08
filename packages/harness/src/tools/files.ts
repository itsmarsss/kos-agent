import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, sep } from "node:path";

import { isOffice, officeNote, officeText } from "../files/office.js";
import { isPdf, pdfText } from "../files/pdftext.js";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { SAFE, type ToolRisk } from "../risk/tiers.js";
import type { Workspace } from "../store/workspace.js";
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

/** True if a workspace-relative path is outside the scratch area. */
export function outsideScratch(path: string): boolean {
  const norm = path.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return norm !== SCRATCH_PREFIX && !norm.startsWith(`${SCRATCH_PREFIX}/`);
}

const rmRisk: ToolRisk = {
  floor: "safe",
  escalate: (input) => (outsideScratch(optStr(input, "path") ?? "") ? "outside the scratch folder" : false),
};

/**
 * A path the file tools may use: anything in the jail but KOS's own state
 * under .kos/, which holds results set aside from other chats and other
 * projects, and is read only through context.recall, which checks whose they are.
 */
function usable(ws: Workspace, path: string): string {
  const abs = ws.resolve(path);
  const rel = relative(ws.root, abs).split(sep);
  if (rel[0] === ".kos") throw new Error(".kos is KOS's own state and is not read or changed with files.*; a result set aside in this chat comes back with context.recall");
  return abs;
}

function defineFileTools(ws: Workspace, ctx: ModuleContext): void {
  /** An artifact's file, version or capture is reached as the artifacts tools reach it: by its owner's chats. */
  const fenced = (path: string, what: "read" | "change", whole = false): string => {
    const abs = usable(ws, path);
    const pages = ctx.services?.pages;
    if (!pages) return abs;
    const rel = relative(ws.root, abs);
    const reach = reachOf(ctx);
    // A folder taken whole (rm, mv, cp) takes every artifact under it, so each one's owner must be this chat's to reach.
    const why = artifactFileRefusal(pages, rel, reach, what) ?? (whole ? artifactFolderRefusal(pages, rel, reach, what) : undefined);
    if (why) throw new Error(why);
    return abs;
  };
  ctx.registerTool(
    {
      name: "files.read",
      description: "Read a file from the workspace: UTF-8 text as it is; a PDF as its text page by page; a Word, Excel or PowerPoint file (.docx, .xlsx, .pptx) as its paragraphs, rows or slides.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    async (input) => {
      const abs = fenced(str(input, "path"), "read");
      const bytes = readFileSync(abs);
      if (isPdf(bytes)) {
        const read = await pdfText(new Uint8Array(bytes));
        return `[PDF, ${read.pages} page${read.pages === 1 ? "" : "s"}${read.truncated ? ", cut at the cap" : ""}]\n${read.text}`;
      }
      if (isOffice(bytes, abs)) {
        const read = officeText(new Uint8Array(bytes), abs);
        return `[${officeNote(read)}]\n${read.text}`;
      }
      return bytes.toString("utf8");
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
      const abs = fenced(str(input, "path"), "change");
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
      const abs = fenced(str(input, "path"), "change");
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
      const to = fenced(str(input, "to"), "change");
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
      const to = fenced(str(input, "to"), "change");
      mkdirSync(dirname(to), { recursive: true });
      renameSync(fenced(str(input, "from"), "change", true), to);
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
      rmSync(fenced(str(input, "path"), "change", true), { recursive: true, force: true });
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
