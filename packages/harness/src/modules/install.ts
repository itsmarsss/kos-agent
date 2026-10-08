import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Workspace } from "../store/workspace.js";
import { MODULE_FILE, MODULE_NAME, MODULES_DIR, parseModuleManifest, type WorkspaceModuleManifest } from "./workspace.js";

/**
 * Getting a module from somewhere else.
 *
 * The spec's distribution path, simplest first: a folder you copy, then a
 * git repository per module, cloneable and versioned. This is the second
 * rung. A module installed from a repository keeps its .git, so updating it
 * is a pull, and the Settings page can say where it came from.
 *
 * Installed is not running. A module arrives switched off like one KOS
 * wrote, and its manifest is checked before it is kept: a folder that is
 * not a module is removed again rather than left to confuse the loader.
 */

const exec = promisify(execFile);

export type Runner = (file: string, args: string[], cwd?: string) => Promise<{ stdout: string }>;

/** The real thing: a program run to completion. Skills install through it too. */
export const run: Runner = async (file, args, cwd) => {
  const { stdout } = await exec(file, args, { ...(cwd ? { cwd } : {}), timeout: 120_000 });
  return { stdout };
};

/** A git URL, and only a git URL: never something git would read as an option. */
export function isGitSource(source: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(source) && !source.startsWith("-");
}

/** The name a source suggests: the repository's, as a module name. */
export function nameFromSource(source: string): string {
  const base = basename(source.replace(/\/+$/, "")).replace(/\.git$/, "");
  const name = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "module";
}

export interface InstalledModule {
  name: string;
  dir: string;
  manifest: WorkspaceModuleManifest;
  origin: string | null;
}

export async function installModule(
  ws: Workspace,
  source: string,
  options: { name?: string; run?: Runner } = {},
): Promise<InstalledModule> {
  const runner = options.run ?? run;
  const name = options.name?.trim() || nameFromSource(source);
  if (!MODULE_NAME.test(name)) throw new Error(`not a module name: ${name}`);
  const dirRel = `${MODULES_DIR}/${name}`;
  const dirAbs = ws.resolve(dirRel);
  if (existsSync(dirAbs)) throw new Error(`a module named ${name} already exists; kos module update ${name} brings it up to date`);

  if (isGitSource(source)) {
    await runner("git", ["clone", "--depth", "1", "--quiet", "--", source, dirAbs]);
  } else {
    const from = resolve(source);
    if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`${source} is neither a git URL nor a folder`);
    cpSync(from, dirAbs, { recursive: true });
  }

  try {
    const manifest = parseModuleManifest(JSON.parse(readFileSync(join(dirAbs, MODULE_FILE), "utf8")), name);
    return { name, dir: dirRel, manifest, origin: await originOf(dirAbs, runner) };
  } catch (err) {
    // Not a module: the folder goes, and the reason comes back.
    rmSync(dirAbs, { recursive: true, force: true });
    throw new Error(`${source} is not a module: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Pull a module installed from a repository. */
export async function updateModule(ws: Workspace, name: string, options: { run?: Runner } = {}): Promise<InstalledModule> {
  const runner = options.run ?? run;
  if (!MODULE_NAME.test(name)) throw new Error(`not a module name: ${name}`);
  const dirRel = `${MODULES_DIR}/${name}`;
  const dirAbs = ws.resolve(dirRel);
  if (!existsSync(dirAbs)) throw new Error(`no module named ${name}`);
  if (!existsSync(join(dirAbs, ".git"))) throw new Error(`${name} was not installed from a repository; there is nothing to pull`);
  await runner("git", ["pull", "--ff-only", "--quiet"], dirAbs);
  const manifest = parseModuleManifest(JSON.parse(readFileSync(join(dirAbs, MODULE_FILE), "utf8")), name);
  return { name, dir: dirRel, manifest, origin: await originOf(dirAbs, runner) };
}

export function removeModule(ws: Workspace, name: string): void {
  if (!MODULE_NAME.test(name)) throw new Error(`not a module name: ${name}`);
  const dirAbs = ws.resolve(`${MODULES_DIR}/${name}`);
  if (!existsSync(dirAbs)) throw new Error(`no module named ${name}`);
  rmSync(dirAbs, { recursive: true, force: true });
}

/** Where a module came from, when it came from a repository. */
export async function originOf(dirAbs: string, runner: Runner = run): Promise<string | null> {
  if (!existsSync(join(dirAbs, ".git"))) return null;
  try {
    const { stdout } = await runner("git", ["remote", "get-url", "origin"], dirAbs);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
