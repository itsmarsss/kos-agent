import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { jailedProgram } from "../sandbox/jail.js";
import { SKILL_NAME } from "../skills/manifest.js";
import type { Workspace } from "../store/workspace.js";
import type { McpServerConfig } from "../tools/mcp.js";
import { parseBlueprint, type Blueprint } from "./blueprint.js";

/**
 * Modules in the workspace: a folder under modules/ with a module.json.
 *
 * The kernel is primitives; a feature is a module. A module is a Model
 * Context Protocol server the folder knows how to start, which is the
 * spec's boundary for anything that is not a primitive: it runs as its
 * own process, in the jail, and the harness floors its tools the way it
 * floors any server's. The agent may write one. It runs only once the
 * owner has switched it on, which is the gate between "KOS wrote some
 * code" and "KOS runs some code".
 */

export const MODULES_DIR = "modules";
export const MODULE_FILE = "module.json";
export const MODULES_KEY = "modules";

/** A module's name is a directory name and a tool prefix. Same rule as a skill. */
export const MODULE_NAME = SKILL_NAME;

export interface WorkspaceModuleManifest {
  name: string;
  description: string;
  /** The program that serves it, run from the module's own directory. Absent for a blueprint-only module. */
  command?: string;
  /** A project template: schema, pages and jobs an instance is made from. */
  blueprint?: Blueprint;
  args?: string[];
  env?: Record<string, string>;
  risk?: "safe" | "risky";
  tools?: Record<string, "safe" | "risky">;
  /** Project slugs this module is for. Its tools exist only in their conversations. Absent means everywhere. */
  projects?: string[];
}

export interface WorkspaceModule {
  manifest: WorkspaceModuleManifest;
  /** Workspace-relative directory, `modules/<name>`. */
  dir: string;
}

export interface InvalidModule {
  name: string;
  reason: string;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && Object.values(v as object).every((x) => typeof x === "string");
}

export function parseModuleManifest(raw: unknown, dirName: string): WorkspaceModuleManifest {
  if (typeof raw !== "object" || raw === null) throw new Error(`${MODULE_FILE} is not an object`);
  const m = raw as Record<string, unknown>;
  const name = typeof m["name"] === "string" ? m["name"].trim() : "";
  if (!MODULE_NAME.test(name)) throw new Error(`name must match ${MODULE_NAME}`);
  if (name !== dirName) throw new Error(`name "${name}" does not match its directory "${dirName}"`);
  const description = typeof m["description"] === "string" ? m["description"].trim() : "";
  if (!description) throw new Error("description is required");
  const command = typeof m["command"] === "string" ? m["command"].trim() : "";
  const blueprint = m["blueprint"] !== undefined ? parseBlueprint(m["blueprint"]) : undefined;
  if (!command && !blueprint) throw new Error("command (the program that serves the module) or blueprint is required");
  const out: WorkspaceModuleManifest = { name, description, ...(command ? { command } : {}), ...(blueprint ? { blueprint } : {}) };
  if (Array.isArray(m["args"])) out.args = m["args"].filter((a): a is string => typeof a === "string");
  if (isStringMap(m["env"])) out.env = m["env"];
  if (m["risk"] === "safe" || m["risk"] === "risky") out.risk = m["risk"];
  if (Array.isArray(m["projects"])) {
    const projects = m["projects"].filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim());
    if (projects.length) out.projects = projects;
  }
  if (typeof m["tools"] === "object" && m["tools"] !== null) {
    const floors: Record<string, "safe" | "risky"> = {};
    for (const [tool, floor] of Object.entries(m["tools"] as Record<string, unknown>)) {
      if (floor === "safe" || floor === "risky") floors[tool] = floor;
    }
    if (Object.keys(floors).length) out.tools = floors;
  }
  return out;
}

/** Every module in the workspace, valid ones and the reasons the rest are not. */
export function readWorkspaceModules(ws: Workspace): { modules: WorkspaceModule[]; invalid: InvalidModule[] } {
  const modules: WorkspaceModule[] = [];
  const invalid: InvalidModule[] = [];
  let root: string;
  try {
    root = ws.resolve(MODULES_DIR);
  } catch {
    return { modules, invalid };
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) return { modules, invalid };
  for (const dirName of readdirSync(root).sort()) {
    const abs = join(root, dirName);
    if (!statSync(abs).isDirectory()) continue;
    const file = join(abs, MODULE_FILE);
    if (!existsSync(file)) {
      invalid.push({ name: dirName, reason: `no ${MODULE_FILE}` });
      continue;
    }
    try {
      const manifest = parseModuleManifest(JSON.parse(readFileSync(file, "utf8")), dirName);
      modules.push({ manifest, dir: `${MODULES_DIR}/${dirName}` });
    } catch (err) {
      invalid.push({ name: dirName, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { modules, invalid };
}

export interface ModuleSettings {
  /** Off is the default: a workspace module runs only after the owner switched it on. */
  enabled: string[];
  /** On is the default for a built-in feature; these are the ones switched off. */
  disabledBuiltins: string[];
}

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()))];
}

export function parseModuleSettings(raw: unknown): ModuleSettings {
  if (typeof raw !== "object" || raw === null) return { enabled: [], disabledBuiltins: [] };
  const r = raw as { enabled?: unknown; disabledBuiltins?: unknown };
  return { enabled: names(r.enabled), disabledBuiltins: names(r.disabledBuiltins) };
}

export function withModuleEnabled(current: ModuleSettings, name: string, enabled: boolean): ModuleSettings {
  const on = new Set(current.enabled);
  if (enabled) on.add(name);
  else on.delete(name);
  return { ...current, enabled: [...on].sort() };
}

export function withBuiltinEnabled(current: ModuleSettings, name: string, enabled: boolean): ModuleSettings {
  const off = new Set(current.disabledBuiltins);
  if (enabled) off.delete(name);
  else off.add(name);
  return { ...current, disabledBuiltins: [...off].sort() };
}

/**
 * The server a module is, as the MCP module understands one: its program
 * run from its own directory, jailed to the workspace unless the host is
 * the jail already, and floored as the manifest says.
 */
export function serverFor(
  module: WorkspaceModule,
  options: { workspaceRoot: string; jail: boolean; instances?: string[] },
): McpServerConfig {
  const command = module.manifest.command;
  if (!command) throw new Error(`${module.manifest.name} is a blueprint: it has no server to run`);
  const { file, args } = options.jail
    ? jailedProgram(command, module.manifest.args ?? [], { workspaceRoot: options.workspaceRoot })
    : { file: command, args: module.manifest.args ?? [] };
  return {
    command: file,
    args,
    cwd: join(options.workspaceRoot, module.dir),
    ...(module.manifest.env ? { env: module.manifest.env } : {}),
    ...(module.manifest.risk ? { risk: module.manifest.risk } : {}),
    ...(module.manifest.tools ? { tools: module.manifest.tools } : {}),
    // A blueprint's server is for its instances; a plain module says its own.
    ...(projectsFor(module, options.instances ?? []).length ? { projects: projectsFor(module, options.instances ?? []) } : {}),
  };
}

function projectsFor(module: WorkspaceModule, instances: string[]): string[] {
  return [...new Set([...(module.manifest.projects ?? []), ...(module.manifest.blueprint ? instances : [])])];
}

/** The servers for the modules the owner switched on. Invalid or unknown names are skipped. */
export function enabledServers(
  ws: Workspace,
  enabled: Iterable<string>,
  jail: boolean,
  /** The instances of a blueprint, so a blueprint's server is scoped to them. */
  instancesOf: (module: string) => string[] = () => [],
): Record<string, McpServerConfig> {
  const on = new Set(enabled);
  const out: Record<string, McpServerConfig> = {};
  for (const module of readWorkspaceModules(ws).modules) {
    // A blueprint alone has nothing to start; on or off, it is a template.
    if (on.has(module.manifest.name) && module.manifest.command) {
      out[module.manifest.name] = serverFor(module, { workspaceRoot: ws.root, jail, instances: instancesOf(module.manifest.name) });
    }
  }
  return out;
}

/** A new module: the manifest and a server that speaks the protocol with no dependencies. */
export function scaffoldModule(ws: Workspace, name: string, description: string): { dir: string; files: string[] } {
  if (!MODULE_NAME.test(name)) throw new Error(`not a module name: ${name}`);
  const dirRel = `${MODULES_DIR}/${name}`;
  const dirAbs = ws.resolve(dirRel);
  if (existsSync(dirAbs)) throw new Error(`a module named ${name} already exists`);
  mkdirSync(dirAbs, { recursive: true });
  const manifest: WorkspaceModuleManifest = {
    name,
    description,
    command: "node",
    args: ["server.mjs"],
    tools: { greet: "safe" },
  };
  writeFileSync(join(dirAbs, MODULE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(dirAbs, "server.mjs"), serverTemplate(name), "utf8");
  return { dir: dirRel, files: [`${dirRel}/${MODULE_FILE}`, `${dirRel}/server.mjs`] };
}

function serverTemplate(name: string): string {
  return `#!/usr/bin/env node
// ${name}: a Model Context Protocol server over stdio, with no dependencies.
// Add a tool: an entry in \`tools\` (name, description, JSON schema) and a
// handler of the same name that returns text. Floors go in module.json.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "greet",
    description: "Say hello to someone",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
];

const handlers = {
  greet: async ({ name }) => \`Hello, \${name ?? "world"}\`,
};

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // a notification needs no answer
  const reply = (result) => send({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id: req.id, error: { code, message } });
  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: ${JSON.stringify(name)}, version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const handler = handlers[req.params?.name];
      if (!handler) return fail(-32602, \`no tool named \${req.params?.name}\`);
      try {
        const text = await handler(req.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: String(text) }] });
      } catch (err) {
        return reply({ content: [{ type: "text", text: err?.message ?? String(err) }], isError: true });
      }
    }
    default:
      return fail(-32601, \`unknown method \${req.method}\`);
  }
});
`;
}
