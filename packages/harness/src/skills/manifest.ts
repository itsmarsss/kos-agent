import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, join, posix } from "node:path";

import type { Workspace } from "../store/workspace.js";

/**
 * What a skill is, and which ones there are.
 *
 * A skill used to be a bare script under skills/, found by its extension and
 * known to the model only as a thing it could write. It had no description,
 * no way to be switched off, and the model was never told which ones
 * existed, so a skill written on Monday was invisible by Wednesday.
 *
 * A skill is now a directory, `skills/<name>/`, with a `skill.json` saying
 * what it is. Two kinds: a script, run in the sandbox and promoted as
 * before; and a prompt skill, a file of instructions loaded into the turn on
 * request, which is what Claude Code calls a skill. Enabled ones are listed
 * in the system prompt by name and description, so the model can reach for
 * one, and the owner can switch any of them off by name without deleting it.
 */

export const SKILLS_DIR = "skills";
export const MANIFEST_FILE = "skill.json";

/** A name is a directory name, and shows up in a prompt. Keep it plain. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type SkillKind = "script" | "prompt";

export interface SkillManifest {
  name: string;
  description: string;
  kind: SkillKind;
  /** Script kind: the entry file inside the skill's directory. */
  entry?: string;
  /** Prompt kind: the instructions file inside the skill's directory. */
  instructions?: string;
  /** Project slugs this skill is for. Absent means everywhere. */
  projects?: string[];
}

export interface SkillRecord {
  manifest: SkillManifest;
  /** Workspace-relative directory, `skills/<name>`. */
  dir: string;
  /** Workspace-relative entry or instructions path. */
  file: string;
}

export interface InvalidSkill {
  name: string;
  reason: string;
}

export function parseManifest(raw: unknown, dirName: string): SkillManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("skill.json is not an object");
  const m = raw as Record<string, unknown>;
  const name = typeof m["name"] === "string" ? m["name"].trim() : "";
  if (!SKILL_NAME.test(name)) throw new Error(`name must match ${SKILL_NAME}`);
  if (name !== dirName) throw new Error(`name "${name}" does not match its directory "${dirName}"`);
  const description = typeof m["description"] === "string" ? m["description"].trim() : "";
  if (!description) throw new Error("description is required");
  const kind = m["kind"];
  if (kind !== "script" && kind !== "prompt") throw new Error('kind must be "script" or "prompt"');
  const out: SkillManifest = { name, description, kind };
  if (kind === "script") {
    const entry = typeof m["entry"] === "string" ? m["entry"].trim() : "";
    if (!/^[A-Za-z0-9_.-]+\.(js|mjs)$/.test(entry)) {
      throw new Error("a script skill needs an entry file in its own directory, ending .js or .mjs");
    }
    out.entry = entry;
  } else {
    const instructions =
      typeof m["instructions"] === "string" && m["instructions"].trim() ? m["instructions"].trim() : "SKILL.md";
    if (!/^[A-Za-z0-9_.-]+$/.test(instructions)) {
      throw new Error("instructions must name a file in the skill's own directory");
    }
    out.instructions = instructions;
  }
  if (Array.isArray(m["projects"])) {
    const projects = m["projects"].filter((p): p is string => typeof p === "string" && p.trim() !== "");
    if (projects.length) out.projects = projects.map((p) => p.trim());
  }
  return out;
}

/** Every skill in the workspace, valid ones and the reasons the rest are not. */
export function readSkills(ws: Workspace): { skills: SkillRecord[]; invalid: InvalidSkill[] } {
  const skills: SkillRecord[] = [];
  const invalid: InvalidSkill[] = [];
  let root: string;
  try {
    root = ws.resolve(SKILLS_DIR);
  } catch {
    return { skills, invalid };
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) return { skills, invalid };

  for (const dirName of readdirSync(root).sort()) {
    const abs = join(root, dirName);
    if (!statSync(abs).isDirectory()) continue;
    const manifestPath = join(abs, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      invalid.push({ name: dirName, reason: `no ${MANIFEST_FILE}` });
      continue;
    }
    try {
      const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")), dirName);
      const file = `${SKILLS_DIR}/${dirName}/${manifest.kind === "script" ? manifest.entry! : manifest.instructions!}`;
      // The file the manifest names has to be inside the jail; resolve checks.
      if (!existsSync(ws.resolve(file))) {
        invalid.push({ name: dirName, reason: `${file} does not exist` });
        continue;
      }
      skills.push({ manifest, dir: `${SKILLS_DIR}/${dirName}`, file });
    } catch (err) {
      invalid.push({ name: dirName, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { skills, invalid };
}

/** The skills an agent may reach: valid, not switched off, and for this project if it says. */
export function offeredSkills(
  all: SkillRecord[],
  disabled: Iterable<string>,
  projectSlug?: string,
): SkillRecord[] {
  const off = new Set(disabled);
  return all.filter((s) => {
    if (off.has(s.manifest.name)) return false;
    if (s.manifest.projects && projectSlug !== undefined) return s.manifest.projects.includes(projectSlug);
    return true;
  });
}

/**
 * The prompt section. Name order, so the cacheable prefix is the same from
 * one turn to the next unless a skill was added, removed or switched.
 */
export function renderSkillsSection(skills: SkillRecord[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = ["## Skills"];
  for (const s of [...skills].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    const scope = s.manifest.projects ? ` [${s.manifest.projects.join(", ")}]` : "";
    lines.push(`- ${s.manifest.name} (${s.manifest.kind})${scope}: ${s.manifest.description}`);
  }
  lines.push(
    "A prompt skill is instructions: call skills.use with its name when the task matches, then follow them. " +
      "A script skill runs: call skills.run with its name. Make a new one with skills.create.",
  );
  return lines.join("\n");
}

/** Most files a skill's folder may hold and still be hashed: past this it is not a skill but a tree. */
export const SKILL_MAX_FILES = 2_000;

/**
 * Every file under a skill's folder, workspace-relative and sorted. A link
 * or anything but a plain file or folder throws: a skill whose code could
 * be elsewhere has no one set of files to say yes to.
 */
function skillFiles(ws: Workspace, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(ws.resolve(rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
      else throw new Error(`${child} is not a plain file: a skill is its own files, with no links`);
      if (out.length > SKILL_MAX_FILES) throw new Error(`${dir} holds more than ${SKILL_MAX_FILES} files`);
    }
  };
  walk(dir);
  return out;
}

/**
 * What a script skill is, as one hash: every file in its folder, its
 * helpers, data and manifest included, read now. An owner's yes is to the
 * code they were shown, so a commit and a run that skips the ask both
 * check the files still hash to what was approved; any change, to any of
 * them, and the skill asks again. Throws for a folder holding a link.
 */
export function skillHash(ws: Workspace, skill: SkillRecord): string {
  const hash = createHash("sha256");
  for (const file of skillFiles(ws, skill.dir)) {
    const abs = ws.resolve(file);
    if (!lstatSync(abs).isFile()) throw new Error(`${file} is not a plain file`);
    hash.update(file).update("\0").update(readFileSync(abs)).update("\0");
  }
  return hash.digest("hex");
}

/** The files' hash now, or nothing for a skill holding a link or past the file cap, which no yes covers. */
export function skillHashNow(ws: Workspace, skill: SkillRecord): string | undefined {
  try {
    return skillHash(ws, skill);
  } catch {
    return undefined;
  }
}

/** Files that are code a run reads as code, by what they are named. */
const SCRIPT_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
/** Code of any other kind, which this cannot read for what it reaches. */
const OTHER_CODE = new Set([".py", ".sh", ".bash", ".zsh", ".rb", ".pl", ".php", ".lua", ".wasm", ".node", ".so", ".dylib", ".exe", ".bat"]);
/** Built-ins that run or load code from elsewhere: a skill using one is not held to its own folder. */
const LOADS_CODE = new Set(["child_process", "worker_threads", "vm", "module", "cluster", "inspector", "wasi"]);
const SPECIFIER = /\b(?:import\s*(?:[^'"()]*?\sfrom\s*)?|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
/** A load whose name is worked out as it runs, or code made from text. */
const OPAQUE = /\b(?:require|import)\s*\(\s*[^'"\s)]|\beval\s*\(|\bnew\s+Function\b|\bprocess\.dlopen\b/;

/**
 * Whether a script skill's code is all in its own folder, so its hash is a
 * hash of what it runs: every code file a script this can read, loading
 * only files inside the folder and Node's own modules, none of those that
 * run code from elsewhere, and nothing loaded by a name made at run time.
 * A skill that reaches out (../lib.js, a package, a Python file) is not,
 * and no learned yes is kept for it: it asks each run unless promoted.
 */
export function skillSelfContained(ws: Workspace, skill: SkillRecord): boolean {
  let files: string[];
  try {
    files = skillFiles(ws, skill.dir);
  } catch {
    return false;
  }
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (OTHER_CODE.has(ext)) return false;
    if (!SCRIPT_EXTS.has(ext)) continue;
    const code = readFileSync(ws.resolve(file), "utf8");
    if (OPAQUE.test(code)) return false;
    for (const m of code.matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) {
        const target = posix.normalize(posix.join(dirname(file), spec));
        if (target !== skill.dir && !target.startsWith(`${skill.dir}/`)) return false;
        continue;
      }
      const bare = spec.startsWith("node:") ? spec.slice("node:".length) : spec;
      if (!isBuiltin(spec) || LOADS_CODE.has(bare.split("/")[0]!)) return false;
    }
  }
  return true;
}
