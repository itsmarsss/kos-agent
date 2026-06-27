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
import { dirname } from "node:path";

import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { SAFE, type ToolRisk } from "../risk/tiers.js";
import type { Workspace } from "../store/workspace.js";

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
  escalate: (input) => outsideScratch(optStr(input, "path") ?? ""),
};

function defineFileTools(ws: Workspace, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "files.read",
      description: "Read a UTF-8 file from the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    (input) => readFileSync(ws.resolve(str(input, "path")), "utf8"),
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
      const abs = ws.resolve(str(input, "path"));
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
      const abs = ws.resolve(str(input, "path"));
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
      const abs = ws.resolve(optStr(input, "path") ?? ".");
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
      const to = ws.resolve(str(input, "to"));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(ws.resolve(str(input, "from")), to);
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
      const to = ws.resolve(str(input, "to"));
      mkdirSync(dirname(to), { recursive: true });
      renameSync(ws.resolve(str(input, "from")), to);
      return "ok";
    },
    { floor: "safe", escalate: (input) => outsideScratch(optStr(input, "from") ?? "") },
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
      rmSync(ws.resolve(str(input, "path")), { recursive: true, force: true });
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
