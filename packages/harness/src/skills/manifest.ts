import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
