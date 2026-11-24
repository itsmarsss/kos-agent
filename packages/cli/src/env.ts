import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository KOS runs from: packages/cli/dist (or src) up three. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Load the harness's env file into process.env without overwriting vars
 * already set in the shell.
 *
 * One file only (envFilePath). Never one from the current directory: run
 * from the workspace, that is a file approved programs can write, and its
 * keys (KOS_UI_DIST, KOS_HOST) would decide what the dashboard serves and
 * where.
 */
export function loadEnv(path = envFilePath()): void {
  if (existsSync(path)) applyEnvFile(path);
}

/**
 * Where the env file is, or where one would go: the settings page needs a
 * path to write even when nothing has been saved yet. KOS_ENV_FILE when the
 * shell names one; else ~/.kos/env when it exists; else the .env at the
 * repository root, where an install made before ~/.kos/env keeps its keys;
 * else ~/.kos/env, a new install's, owner-only and outside any folder a
 * checkout may be synced or shared from.
 */
export function envFilePath(env: NodeJS.ProcessEnv = process.env, repo = REPO_ROOT): string {
  const named = env.KOS_ENV_FILE?.trim();
  if (named) return resolve(named);
  const kos = join(env.HOME || homedir(), ".kos", "env");
  const legacy = join(repo, ".env");
  return !existsSync(kos) && existsSync(legacy) ? legacy : kos;
}

/**
 * Where a pick's credential files go (Google's OAuth client and tokens): a
 * `secrets` folder beside the file KOS_ENV_FILE names, else beside the
 * repository's .env, as before ~/.kos/env. Never in ~/.kos: the MCP server
 * that reads them runs jailed, and the jail denies ~/.kos.
 */
export function credentialsDir(env: NodeJS.ProcessEnv = process.env, repo = REPO_ROOT): string {
  const named = env.KOS_ENV_FILE?.trim();
  return join(named ? dirname(resolve(named)) : repo, "secrets");
}

function applyEnvFile(path: string): void {
  const text = readFileSync(path, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(line.slice(eq + 1).trim());
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
