import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseGithubTree } from "../catalog/github.js";
import { isGitSource, nameFromSource, originOf, run, type Runner } from "../modules/install.js";
import type { Workspace } from "../store/workspace.js";
import { MANIFEST_FILE, SKILL_NAME, SKILLS_DIR, parseManifest, type SkillManifest } from "./manifest.js";

/**
 * Getting a skill from somewhere else.
 *
 * The same two rungs as a module: a folder you copy, or a git repository
 * that can be pulled later. A skill is either KOS's own shape, a folder with
 * a skill.json, or the shape Claude Code uses, a folder with a SKILL.md
 * whose front matter names and describes it; the second is read as a
 * prompt skill and given a skill.json, so from then on it is one of ours.
 *
 * What arrives is held under a temporary name until its manifest has been
 * read, because the name comes from the manifest, not the URL. A folder
 * that turns out not to be a skill is removed again. Installed is not on:
 * the caller switches an installed skill off until the owner says.
 */

export interface InstalledSkill {
  name: string;
  /** Workspace-relative, `skills/<name>`. */
  dir: string;
  manifest: SkillManifest;
  origin: string | null;
}

/** Thrown when the name is taken, which is not a reason to call the source bad. */
class SkillExists extends Error {}

/**
 * A manifest from a SKILL.md: its YAML front matter's name and description,
 * or failing those the folder's name and the file's first line of prose.
 */
export function manifestFromSkillMd(text: string, fallbackName: string): SkillManifest {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const field = (key: string): string | undefined => {
    if (!front) return undefined;
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(front[1]!);
    if (!m) return undefined;
    const value = (m[1] ?? "").trim();
    // A block scalar (`>` folded, `|` literal) runs on over the indented
    // lines beneath. Read as one line either way: a description is prose.
    if (/^[>|][+-]?$/.test(value)) {
      const rest = front[1]!.slice((m.index ?? 0) + m[0].length).split(/\r?\n/);
      const lines: string[] = [];
      for (const line of rest) {
        if (line.trim() === "") continue;
        if (!/^[ \t]/.test(line)) break;
        lines.push(line.trim());
      }
      return lines.join(" ") || undefined;
    }
    return value.replace(/^(["'])(.*)\1$/, "$2") || undefined;
  };
  const body = front ? text.slice(front[0].length) : text;
  const prose = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return {
    name: field("name") ?? fallbackName,
    description: field("description") ?? prose ?? "",
    kind: "prompt",
    instructions: "SKILL.md",
  };
}

/** Where a skill taken from inside a repository came from, since it has no .git of its own. */
export const ORIGIN_FILE = ".kos-origin";

export async function installSkill(
  ws: Workspace,
  source: string,
  options: { name?: string; run?: Runner } = {},
): Promise<InstalledSkill> {
  const runner = options.run ?? run;
  const root = ws.resolve(SKILLS_DIR);
  mkdirSync(root, { recursive: true });
  const holding = join(root, `.installing-${Date.now().toString(36)}`);
  const tree = parseGithubTree(source);

  if (tree) {
    // A folder inside a repository, the shape a collection of skills has.
    // The whole repository is cloned shallow and the folder lifted out; the
    // source is written down beside it, since the folder has no .git to ask.
    const checkout = join(root, `.cloning-${Date.now().toString(36)}`);
    try {
      await runner("git", [
        "clone", "--depth", "1", "--quiet", "--branch", tree.ref, "--", `https://github.com/${tree.owner}/${tree.repo}.git`, checkout,
      ]);
      const folder = join(checkout, ...tree.path.split("/"));
      if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${tree.path} is not a folder in ${tree.owner}/${tree.repo}`);
      cpSync(folder, holding, { recursive: true });
      writeFileSync(join(holding, ORIGIN_FILE), `${source.trim()}\n`, "utf8");
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  } else if (isGitSource(source)) {
    await runner("git", ["clone", "--depth", "1", "--quiet", "--", source, holding]);
  } else {
    const from = resolve(source);
    if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`${source} is neither a git URL nor a folder`);
    cpSync(from, holding, { recursive: true });
  }

  try {
    const manifestPath = join(holding, MANIFEST_FILE);
    let raw: Record<string, unknown>;
    if (existsSync(manifestPath)) {
      raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    } else if (existsSync(join(holding, "SKILL.md"))) {
      raw = { ...manifestFromSkillMd(readFileSync(join(holding, "SKILL.md"), "utf8"), nameFromSource(source)) };
    } else {
      throw new Error(`no ${MANIFEST_FILE} and no SKILL.md`);
    }
    const name =
      options.name?.trim() || (typeof raw["name"] === "string" ? raw["name"].trim() : "") || nameFromSource(source);
    if (!SKILL_NAME.test(name)) throw new Error(`not a skill name: ${name}`);
    // The manifest names its own directory. Given a name, it is told the name.
    const manifest = parseManifest({ ...raw, name }, name);
    const named = manifest.kind === "script" ? manifest.entry! : manifest.instructions!;
    if (!existsSync(join(holding, named))) throw new Error(`${named} does not exist`);
    const dirAbs = join(root, name);
    if (existsSync(dirAbs)) {
      throw new SkillExists(`a skill named ${name} already exists; kos skill update ${name} brings it up to date`);
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(holding, dirAbs);
    return { name, dir: `${SKILLS_DIR}/${name}`, manifest, origin: await skillOrigin(dirAbs, runner) };
  } catch (err) {
    // Not a skill, or not room for it: the folder goes, and the reason comes back.
    rmSync(holding, { recursive: true, force: true });
    if (err instanceof SkillExists) throw err;
    throw new Error(`${source} is not a skill: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The repository a skill came from: its own remote, or the folder source written at install. */
export async function skillOrigin(dirAbs: string, runner: Runner): Promise<string | null> {
  const own = await originOf(dirAbs, runner);
  if (own) return own;
  const noted = join(dirAbs, ORIGIN_FILE);
  return existsSync(noted) ? readFileSync(noted, "utf8").trim() || null : null;
}

/** Pull a skill installed from a repository. */
export async function updateSkill(ws: Workspace, name: string, options: { run?: Runner } = {}): Promise<InstalledSkill> {
  const runner = options.run ?? run;
  if (!SKILL_NAME.test(name)) throw new Error(`not a skill name: ${name}`);
  const dirRel = `${SKILLS_DIR}/${name}`;
  const dirAbs = ws.resolve(dirRel);
  if (!existsSync(dirAbs)) throw new Error(`no skill named ${name}`);
  // Lifted out of a repository: there is nothing to pull, so it is fetched
  // again from where it came and the folder replaced whole.
  const noted = join(dirAbs, ORIGIN_FILE);
  if (!existsSync(join(dirAbs, ".git")) && existsSync(noted)) {
    const source = readFileSync(noted, "utf8").trim();
    rmSync(dirAbs, { recursive: true, force: true });
    return installSkill(ws, source, { name, run: runner });
  }
  if (!existsSync(join(dirAbs, ".git"))) throw new Error(`${name} was not installed from a repository; there is nothing to pull`);
  await runner("git", ["pull", "--ff-only", "--quiet"], dirAbs);
  const manifestPath = join(dirAbs, MANIFEST_FILE);
  // A repository in Claude Code's shape has no skill.json of its own; ours
  // is rewritten from the SKILL.md it pulled.
  const raw: Record<string, unknown> = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>)
    : { ...manifestFromSkillMd(readFileSync(join(dirAbs, "SKILL.md"), "utf8"), name) };
  const manifest = parseManifest({ ...raw, name }, name);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { name, dir: dirRel, manifest, origin: await skillOrigin(dirAbs, runner) };
}

export function removeSkill(ws: Workspace, name: string): void {
  if (!SKILL_NAME.test(name)) throw new Error(`not a skill name: ${name}`);
  const dirAbs = ws.resolve(`${SKILLS_DIR}/${name}`);
  if (!existsSync(dirAbs)) throw new Error(`no skill named ${name}`);
  rmSync(dirAbs, { recursive: true, force: true });
}
