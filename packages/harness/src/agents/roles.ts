import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Workspace } from "../store/workspace.js";

/**
 * A role: a standing agent KOS can make from a sentence.
 *
 * "Keep an eye on this listing", "handle my travel", "plan Saturdays":
 * each is a responsibility rather than a question, and a responsibility
 * needs somewhere to live between asks. A role is that place, as a folder
 * of its own with a file the owner can read and edit: `agents/<name>/agent.md`,
 * a few lines of frontmatter saying what the agent may reach and when it
 * runs, and the brief as the body; the rest of the folder is the agent's. Nothing about a role is code. KOS writes one with
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

/**
 * What the owner may set about an agent's face: its hue, its eyes, its
 * gait. Anything unset comes from the name, so a face needs no setting at
 * all. KOS's own face is the same shape, kept in settings under KOS_FACE_KEY.
 */
export interface FaceLook {
  hue?: number;
  /** Any colour, #rrggbb, for a body the hue's own fill does not give. */
  colour?: string;
  eyes?: "round" | "half" | "sparkle";
  gait?: 0 | 1 | 2 | 3;
}

export const KOS_FACE_KEY = "kos.face";
const EYES = ["round", "half", "sparkle"] as const;
const HEX = /^#[0-9a-f]{6}$/i;

/** A face from an object: numbers and names checked, the rest dropped. */
export function parseFaceLook(raw: unknown): FaceLook {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: FaceLook = {};
  const hue = typeof r["hue"] === "number" ? r["hue"] : typeof r["hue"] === "string" ? Number(r["hue"]) : NaN;
  if (Number.isFinite(hue)) out.hue = ((Math.round(hue) % 360) + 360) % 360;
  if (typeof r["colour"] === "string" && HEX.test(r["colour"].trim())) out.colour = r["colour"].trim().toLowerCase();
  if (typeof r["eyes"] === "string" && (EYES as readonly string[]).includes(r["eyes"])) out.eyes = r["eyes"] as FaceLook["eyes"];
  const gait = typeof r["gait"] === "number" ? r["gait"] : typeof r["gait"] === "string" ? Number(r["gait"]) : NaN;
  if ([0, 1, 2, 3].includes(gait)) out.gait = gait as FaceLook["gait"];
  return out;
}

/** "hue 210, eyes sparkle, gait 2, colour #3b82f6" into a face; a part it cannot read is an error. */
export function parseFaceText(text: string): FaceLook {
  const raw: Record<string, string> = {};
  for (const part of text.split(",")) {
    const words = part.trim().split(/[\s=:]+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.length !== 2 || !["hue", "eyes", "gait", "colour"].includes(words[0]!)) {
      throw new Error(`face: "${part.trim()}" is not "hue <0-359>", "eyes <round|half|sparkle>", "gait <0-3>" or "colour #rrggbb"`);
    }
    raw[words[0]!] = words[1]!;
  }
  const face = parseFaceLook(raw);
  for (const key of Object.keys(raw)) {
    if (!(key in face)) throw new Error(`face: "${key} ${raw[key]}" is out of range`);
  }
  return face;
}

export function formatFaceText(face: FaceLook): string {
  return [
    ...(face.hue !== undefined ? [`hue ${face.hue}`] : []),
    ...(face.colour ? [`colour ${face.colour}`] : []),
    ...(face.eyes ? [`eyes ${face.eyes}`] : []),
    ...(face.gait !== undefined ? [`gait ${face.gait}`] : []),
  ].join(", ");
}

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
  /** What the owner set about its face; absent, the name decides. */
  face?: FaceLook;
}

export interface RoleRecord extends Role {
  /** Workspace-relative path of the file, agents/<name>/agent.md. */
  path: string;
  /** The agent's own folder, agents/<name>, where it keeps what it makes. */
  folder: string;
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

const KEYS = new Set(["name", "description", "tools", "memory", "task", "schedule", "prompt", "face"]);

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
  if (name !== fileName) throw new Error(`name "${name}" does not match its folder "${fileName}"`);
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
  const faceText = head.get("face");
  const face = faceText ? parseFaceText(faceText) : undefined;
  return {
    name,
    description,
    brief: body,
    memory,
    ...(tools ? { tools } : {}),
    ...(task ? { task } : {}),
    ...(schedule ? { schedule } : {}),
    ...(prompt ? { prompt } : {}),
    ...(face && Object.keys(face).length ? { face } : {}),
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
    ...(role.face && formatFaceText(role.face) ? [`face: ${formatFaceText(role.face)}`] : []),
  ];
  return `---\n${head.join("\n")}\n---\n\n${role.brief.trim()}\n`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The file inside an agent's folder that says what it is. */
export const ROLE_FILE = "agent.md";

/**
 * The roles in a workspace, read from disk on every call so an edit is live.
 *
 * An agent is a folder, `agents/<name>/`, with its file `agent.md` in it.
 * The folder is the agent's own: where it keeps its notes and whatever it
 * makes, the way a project has a folder. The file alone was the first
 * shape; one met on disk is moved into its folder.
 */
export class RoleStore {
  constructor(private readonly workspace: Workspace) {}

  private dir(): string {
    return this.workspace.resolve(AGENTS_DIR);
  }

  /** The agent's own folder, workspace-relative. */
  folderOf(name: string): string {
    return `${AGENTS_DIR}/${name}`;
  }

  /** The agent's file, workspace-relative. */
  pathOf(name: string): string {
    return `${this.folderOf(name)}/${ROLE_FILE}`;
  }

  /**
   * The file a role was before agents had folders, `agents/<name>.md`, if
   * one is there. A note an agent left beside the roles is not one: a role
   * file opens with its frontmatter line, and that is the tell.
   */
  private flatOf(name: string): string | undefined {
    const flat = this.workspace.resolve(`${AGENTS_DIR}/${name}.md`);
    if (!existsSync(flat) || !statSync(flat).isFile()) return undefined;
    return /^---\r?\n/.test(readFileSync(flat, "utf8")) ? flat : undefined;
  }

  /** A role from before agents had folders, moved into its folder. */
  private adopt(name: string): void {
    const flat = this.flatOf(name);
    if (!flat) return;
    const abs = this.workspace.resolve(this.pathOf(name));
    if (existsSync(abs)) {
      rmSync(flat);
      return;
    }
    mkdirSync(this.workspace.resolve(this.folderOf(name)), { recursive: true });
    renameSync(flat, abs);
  }

  list(): { roles: RoleRecord[]; invalid: InvalidRole[] } {
    const dir = this.dir();
    if (!existsSync(dir)) return { roles: [], invalid: [] };
    // A folder with an agent.md in it, or a file from before; anything else
    // under agents/ is not an agent and is left alone.
    const names = new Set<string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && this.flatOf(entry.name.slice(0, -3))) names.add(entry.name.slice(0, -3));
      else if (entry.isDirectory() && existsSync(join(dir, entry.name, ROLE_FILE))) names.add(entry.name);
    }
    const roles: RoleRecord[] = [];
    const invalid: InvalidRole[] = [];
    for (const name of [...names].sort()) {
      if (!ROLE_NAME.test(name)) {
        invalid.push({ name, path: `${AGENTS_DIR}/${name}`, reason: `name must match ${ROLE_NAME}` });
        continue;
      }
      this.adopt(name);
      const path = this.pathOf(name);
      try {
        const abs = this.workspace.resolve(path);
        const role = parseRole(readFileSync(abs, "utf8"), name);
        roles.push({ ...role, path, folder: this.folderOf(name), updatedAt: statSync(abs).mtimeMs });
      } catch (err) {
        invalid.push({ name, path, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { roles, invalid };
  }

  /** The role, or undefined when there is no such file or it does not parse. */
  get(name: string): RoleRecord | undefined {
    if (!ROLE_NAME.test(name)) return undefined;
    this.adopt(name);
    const path = this.pathOf(name);
    const abs = this.workspace.resolve(path);
    if (!existsSync(abs)) return undefined;
    try {
      return { ...parseRole(readFileSync(abs, "utf8"), name), path, folder: this.folderOf(name), updatedAt: statSync(abs).mtimeMs };
    } catch {
      return undefined;
    }
  }

  exists(name: string): boolean {
    if (!ROLE_NAME.test(name)) return false;
    return existsSync(this.workspace.resolve(this.pathOf(name))) || this.flatOf(name) !== undefined;
  }

  /** Write the file, whole, in its folder; the role it describes is what parseRole gives back. */
  write(role: Role): RoleRecord {
    if (!ROLE_NAME.test(role.name)) throw new Error(`name must match ${ROLE_NAME}`);
    const text = formatRole(role);
    // Round-tripped before it is written, so a brief or prompt the parser
    // would refuse never lands on disk as a role nothing can read.
    parseRole(text, role.name);
    this.adopt(role.name);
    mkdirSync(this.workspace.resolve(this.folderOf(role.name)), { recursive: true });
    const path = this.pathOf(role.name);
    const abs = this.workspace.resolve(path);
    writeFileSync(abs, text, "utf8");
    return { ...parseRole(text, role.name), path, folder: this.folderOf(role.name), updatedAt: statSync(abs).mtimeMs };
  }

  /**
   * Remove the agent's file. Its folder goes too when nothing else is in it;
   * one holding the agent's work is left, since that work is the owner's.
   */
  remove(name: string): boolean {
    if (!this.exists(name)) return false;
    this.adopt(name);
    rmSync(this.workspace.resolve(this.pathOf(name)));
    const folder = this.workspace.resolve(this.folderOf(name));
    if (existsSync(folder) && readdirSync(folder).length === 0) rmSync(folder, { recursive: true });
    return true;
  }
}
