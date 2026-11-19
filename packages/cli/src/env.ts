import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the harness's gitignored .env into process.env without overwriting
 * vars already set in the shell.
 *
 * One file only: KOS_ENV_FILE when the shell names one, else the .env at the
 * repository root. Never one from the current directory: run from the
 * workspace, that is a file approved programs can write, and its keys
 * (KOS_UI_DIST, KOS_HOST) would decide what the dashboard serves and where.
 */
export function loadEnv(path = envFilePath()): void {
  if (existsSync(path)) applyEnvFile(path);
}

/**
 * Where the env file is, or where one would go: the settings page needs a
 * path to write even when nothing has been saved yet.
 */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.KOS_ENV_FILE?.trim();
  if (named) return resolve(named);
  // packages/cli/dist (or src) -> repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..", ".env");
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
