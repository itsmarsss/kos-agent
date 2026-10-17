import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import type { Workspace } from "../store/workspace.js";

/**
 * A role: a standing agent KOS can make from a sentence.
 *
 * "Keep an eye on this listing", "handle my travel", "plan Saturdays":
 * each is a responsibility rather than a question, and a responsibility
 * needs somewhere to live between asks. A role is that place, as a file
 * the owner can read and edit: `agents/<name>.md`, a few lines of
 * frontmatter saying what the agent may reach and when it runs, and the
 * brief as the body. Nothing about a role is code. KOS writes one with
 * agents.create, dispatches work to it, and reads the file again on every
 * turn, so an edit is the next turn's brief.
 *
 * A role has one standing thread, `agent:<name>`, where it is spoken to
 * at the root and where its schedule runs; dispatched into a project it
 * gets an ordinary conversation there, under the same brief.
 */

export const AGENTS_DIR = "agents";
/** A name is a file name and a thread id, and shows up in a prompt. Keep it plain. */
export const ROLE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type RoleMemory = "own" | "shared";

export interface Role {
  name: string;
  /** One line: what it is for, as a list would show it. */
  description: string;
  /** Standing instructions, the body of the file. */
  brief: string;
  /** Tool families it may reach: "browser", "memory", "files". Absent is the full toolkit. */
  tools?: string[];
  /**
   * Where what it remembers goes. "own" is a scope of its own, agent:<name>,
   * read beside the global claims in its turns; "shared" is the ordinary
   * rule, the project it is in or global.
   */
  memory: RoleMemory;
  /** Which model class answers: the reasoning route unless it says cheap. */
  task?: "reasoning" | "cheap";
  /** A cron expression: when it runs unattended, in its own thread. */
  schedule?: string;
  /** What it is told on each scheduled run. Required with a schedule. */
  prompt?: string;
}

export interface RoleRecord extends Role {
  /** Workspace-relative path of the file. */
  path: string;
  updatedAt: number;
}

export interface InvalidRole {
  name: string;
  path: string;
  reason: string;
}

/** The memory scope a role with memory "own" writes to and reads. */
export function agentScope(name: string): string {
  return `agent:${name}`;
}

/** The id of a role's standing thread. */
export function agentConversationId(name: string): string {
  return `agent:${name}`;
}

const KEYS = new Set(["name", "description", "tools", "memory", "task", "schedule", "prompt"]);

/**
 * The file's head, as `key: value` lines between two `---` lines. Lists are
 * comma-separated. No YAML: the few fields a role has do not need a parser
 * the owner has to know the corners of, and a typo in a key is an error
 * rather than a silently ignored line.
 */
function splitFrontmatter(text: string): { head: Map<string, string>; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("a role file starts with a --- line");
  const head = new Map<string, string>();
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "---") break;
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`not a key: value line: "${line}"`);
    const key = line.slice(0, colon).trim();
    if (!KEYS.has(key)) throw new Error(`unknown key "${key}"; one of ${[...KEYS].join(", ")}`);
    if (head.has(key)) throw new Error(`"${key}" is given twice`);
    head.set(key, line.slice(colon + 1).trim());
  }
  if (i >= lines.length) throw new Error("the frontmatter never closes with a --- line");
  return { head, body: lines.slice(i + 1).join("\n").trim() };
}

function list(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const items = raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function parseRole(text: string, fileName: string): Role {
  const { head, body } = splitFrontmatter(text);
  const name = head.get("name") ?? fileName;
  if (!ROLE_NAME.test(name)) throw new Error(`name must match ${ROLE_NAME}`);
  if (name !== fileName) throw new Error(`name "${name}" does not match its file "${fileName}.md"`);
  const description = head.get("description") ?? "";
  if (!description) throw new Error("description is required");
  if (!body) throw new Error("the body is the brief, and it is empty");
  const memory = head.get("memory") ?? "own";
  if (memory !== "own" && memory !== "shared") throw new Error('memory must be "own" or "shared"');
  const task = head.get("task");
  if (task !== undefined && task !== "" && task !== "reasoning" && task !== "cheap") {
    throw new Error('task must be "reasoning" or "cheap"');
  }
  const tools = list(head.get("tools"));
  for (const t of tools ?? []) {
    if (!/^[a-z][a-z0-9_.]*$/.test(t)) throw new Error(`not a tool family: "${t}"`);
  }
  const schedule = head.get("schedule") || undefined;
  const prompt = head.get("prompt") || undefined;
  if (schedule && !prompt) throw new Error("a schedule needs a prompt: what to do on each run");
  return {
    name,
    description,
    brief: body,
    memory,
    ...(tools ? { tools } : {}),
    ...(task ? { task } : {}),
    ...(schedule ? { schedule } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/** The file for a role, in the shape parseRole reads back. */
export function formatRole(role: Role): string {
  const head = [
    `name: ${role.name}`,
    `description: ${oneLine(role.description)}`,
    ...(role.tools?.length ? [`tools: ${role.tools.join(", ")}`] : []),
    `memory: ${role.memory}`,
    ...(role.task ? [`task: ${role.task}`] : []),
    ...(role.schedule ? [`schedule: ${role.schedule}`] : []),
    ...(role.prompt ? [`prompt: ${oneLine(role.prompt)}`] : []),
  ];
  return `---\n${head.join("\n")}\n---\n\n${role.brief.trim()}\n`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The roles in a workspace, read from disk on every call so an edit is live. */
export class RoleStore {
  constructor(private readonly workspace: Workspace) {}

  private dir(): string {
    return this.workspace.resolve(AGENTS_DIR);
  }

  pathOf(name: string): string {
    return `${AGENTS_DIR}/${name}.md`;
  }

  list(): { roles: RoleRecord[]; invalid: InvalidRole[] } {
    const dir = this.dir();
    if (!existsSync(dir)) return { roles: [], invalid: [] };
    const roles: RoleRecord[] = [];
    const invalid: InvalidRole[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const name = file.slice(0, -3);
      const path = this.pathOf(name);
      try {
        const abs = this.workspace.resolve(path);
        const role = parseRole(readFileSync(abs, "utf8"), name);
        roles.push({ ...role, path, updatedAt: statSync(abs).mtimeMs });
      } catch (err) {
        invalid.push({ name, path, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { roles, invalid };
  }

  /** The role, or undefined when there is no such file or it does not parse. */
  get(name: string): RoleRecord | undefined {
    if (!ROLE_NAME.test(name)) return undefined;
    const path = this.pathOf(name);
    const abs = this.workspace.resolve(path);
    if (!existsSync(abs)) return undefined;
    try {
      return { ...parseRole(readFileSync(abs, "utf8"), name), path, updatedAt: statSync(abs).mtimeMs };
    } catch {
      return undefined;
    }
  }

  exists(name: string): boolean {
    return ROLE_NAME.test(name) && existsSync(this.workspace.resolve(this.pathOf(name)));
  }

  /** Write the file, whole; the role it describes is what parseRole gives back. */
  write(role: Role): RoleRecord {
    if (!ROLE_NAME.test(role.name)) throw new Error(`name must match ${ROLE_NAME}`);
    const text = formatRole(role);
    // Round-tripped before it is written, so a brief or prompt the parser
    // would refuse never lands on disk as a role nothing can read.
    parseRole(text, role.name);
    mkdirSync(this.dir(), { recursive: true });
    const path = this.pathOf(role.name);
    const abs = this.workspace.resolve(path);
    writeFileSync(abs, text, "utf8");
    return { ...parseRole(text, role.name), path, updatedAt: statSync(abs).mtimeMs };
  }

  remove(name: string): boolean {
    if (!this.exists(name)) return false;
    rmSync(this.workspace.resolve(this.pathOf(name)));
    return true;
  }
}
