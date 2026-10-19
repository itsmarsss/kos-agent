import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Workspace } from "../store/workspace.js";

/**
 * A role: a blob, the standing helper KOS makes from a sentence.
 *
 * "Keep an eye on this listing", "handle my travel", "plan Saturdays":
 * each is a responsibility rather than a question, and a responsibility
 * needs somewhere to live between asks. A role is that place, as a folder
 * of its own with a file the owner can read and edit: `blobs/<name>/blob.md`,
 * a few lines of frontmatter saying what the blob may reach and when it
 * runs, and the brief as the body; the rest of the folder is the blob's.
 * Nothing about a role is code. KOS writes one with blobs.create, dispatches
 * work to it, and reads the file again on every turn, so an edit is the
 * next turn's brief.
 *
 * A role has one standing thread, `agent:<name>` (the id is from when
 * blobs were called agents, and is not shown), where it is spoken to at
 * the root and where its schedule runs; dispatched into a project it gets
 * an ordinary conversation there, under the same brief.
 */

export const AGENTS_DIR = "blobs";
/** Where roles lived before they were blobs; anything of theirs still there is moved. */
const LEGACY_DIR = "agents";
const LEGACY_FILE = "agent.md";
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
  /**
   * "always": after each scheduled run, its answer goes to the owner on
   * their surface, tagged as the blob's. Absent, a run's answer stays in
   * the blob's thread and the owner hears only what the brief says to tell.
   */
  report?: "always";
  /** What the owner set about its face; absent, the name decides. */
  face?: FaceLook;
}

export interface RoleRecord extends Role {
  /** Workspace-relative path of the file, blobs/<name>/blob.md. */
  path: string;
  /** The blob's own folder, blobs/<name>, where it keeps what it makes. */
  folder: string;
  updatedAt: number;
}

export interface InvalidRole {
  name: string;
  path: string;
  reason: string;
}

/** The memory scope a role with memory "own" writes to and reads; the prefix is from when blobs were agents. */
export function agentScope(name: string): string {
  return `agent:${name}`;
}

/** The id of a role's standing thread. */
export function agentConversationId(name: string): string {
  return `agent:${name}`;
}

const KEYS = new Set(["name", "description", "tools", "memory", "task", "schedule", "prompt", "report", "face"]);

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
  const report = head.get("report") || undefined;
  if (report !== undefined && report !== "always") throw new Error('report must be "always", or left out');
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
    ...(report ? { report } : {}),
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
    ...(role.report ? [`report: ${role.report}`] : []),
    ...(role.face && formatFaceText(role.face) ? [`face: ${formatFaceText(role.face)}`] : []),
  ];
  return `---\n${head.join("\n")}\n---\n\n${role.brief.trim()}\n`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The file inside a blob's folder that says what it is. */
export const ROLE_FILE = "blob.md";

/**
 * The roles in a workspace, read from disk on every call so an edit is live.
 *
 * A blob is a folder, `blobs/<name>/`, with its file `blob.md` in it. The
 * folder is the blob's own: where it keeps its notes and whatever it makes,
 * the way a project has a folder. Earlier shapes (a flat file, and the
 * `agents/<name>/agent.md` of when blobs were agents) are moved into place
 * when met.
 */
export class RoleStore {
  constructor(private readonly workspace: Workspace) {}

  private dir(): string {
    return this.workspace.resolve(AGENTS_DIR);
  }

  /** The blob's own folder, workspace-relative. */
  folderOf(name: string): string {
    return `${AGENTS_DIR}/${name}`;
  }

  /** The blob's file, workspace-relative. */
  pathOf(name: string): string {
    return `${this.folderOf(name)}/${ROLE_FILE}`;
  }

  /**
   * A flat role file, `<dir>/<name>.md`, if one is there. A note an agent
   * left beside the roles is not one: a role file opens with its
   * frontmatter line, and that is the tell.
   */
  private flatIn(dir: string, name: string): string | undefined {
    const flat = this.workspace.resolve(`${dir}/${name}.md`);
    if (!existsSync(flat) || !statSync(flat).isFile()) return undefined;
    return /^---\r?\n/.test(readFileSync(flat, "utf8")) ? flat : undefined;
  }

  /** Whether a folder holds a role file under either of its names. */
  private roleFileIn(dirAbs: string): string | undefined {
    for (const file of [ROLE_FILE, LEGACY_FILE]) {
      const abs = join(dirAbs, file);
      if (existsSync(abs) && statSync(abs).isFile()) return abs;
    }
    return undefined;
  }

  /**
   * A role from an earlier shape, moved into `blobs/<name>/blob.md`: a flat
   * file in either directory, or a folder under the old directory, or a
   * folder here whose file still carries the old name. Anything that is not
   * a role's is left where it is.
   */
  private adopt(name: string): void {
    const home = this.workspace.resolve(this.folderOf(name));
    const abs = this.workspace.resolve(this.pathOf(name));
    const legacyDir = this.workspace.resolve(`${LEGACY_DIR}/${name}`);
    if (!existsSync(abs) && existsSync(legacyDir) && statSync(legacyDir).isDirectory() && this.roleFileIn(legacyDir)) {
      if (existsSync(home)) {
        // Both exist: the blob's own folder wins; the old file is retired, the rest left.
        rmSync(this.roleFileIn(legacyDir)!);
      } else {
        mkdirSync(this.workspace.resolve(AGENTS_DIR), { recursive: true });
        renameSync(legacyDir, home);
      }
    }
    for (const flat of [this.flatIn(AGENTS_DIR, name), this.flatIn(LEGACY_DIR, name)]) {
      if (!flat) continue;
      if (existsSync(abs) || this.roleFileIn(home)) {
        rmSync(flat);
        continue;
      }
      mkdirSync(home, { recursive: true });
      renameSync(flat, abs);
    }
    const old = join(home, LEGACY_FILE);
    if (!existsSync(abs) && existsSync(old)) renameSync(old, abs);
  }

  /** The role names an earlier layout still holds, so a list finds them before they are moved. */
  private legacyNames(): string[] {
    const dir = this.workspace.resolve(LEGACY_DIR);
    if (!existsSync(dir)) return [];
    const names: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && this.flatIn(LEGACY_DIR, entry.name.slice(0, -3))) names.push(entry.name.slice(0, -3));
      else if (entry.isDirectory() && this.roleFileIn(join(dir, entry.name))) names.push(entry.name);
    }
    return names;
  }

  list(): { roles: RoleRecord[]; invalid: InvalidRole[] } {
    const dir = this.dir();
    // A folder with a role file in it, or a flat file from before; anything
    // else under blobs/ is not a blob and is left alone. The old directory
    // is read too, so what is still there is found and moved.
    const names = new Set<string>(this.legacyNames());
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md") && this.flatIn(AGENTS_DIR, entry.name.slice(0, -3))) names.add(entry.name.slice(0, -3));
        else if (entry.isDirectory() && this.roleFileIn(join(dir, entry.name))) names.add(entry.name);
      }
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
    this.adopt(name);
    return existsSync(this.workspace.resolve(this.pathOf(name)));
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
   * Remove the blob's file. Its folder goes too when nothing else is in it;
   * one holding the blob's work is left, since that work is the owner's.
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
