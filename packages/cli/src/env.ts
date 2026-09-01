import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load a gitignored .env into process.env without overwriting vars already set
 * in the shell. Looks at cwd first, then the monorepo root (relative to this
 * package), so `pnpm kos` and `node packages/cli/dist/main.js` both work.
 */
export function loadEnv(): void {
  for (const path of envCandidates()) {
    if (!existsSync(path)) continue;
    applyEnvFile(path);
    return;
  }
}

/**
 * Where an env file is, or where one would go.
 *
 * The settings page needs a path to write even when nothing has been saved
 * yet, so an existing file wins and the repo root is the fallback rather than
 * there being no answer.
 */
export function envFilePath(): string {
  const candidates = envCandidates();
  return candidates.find((path) => existsSync(path)) ?? candidates[1] ?? candidates[0]!;
}

function envCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/cli/dist -> repo root
  const repoRoot = resolve(here, "../../..");
  return [
    resolve(process.cwd(), ".env"),
    resolve(repoRoot, ".env"),
  ];
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
