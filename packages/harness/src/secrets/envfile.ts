import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Reading and writing the file secrets live in.
 *
 * The owner should not have to edit a dotfile to change an API key, which
 * means the dashboard has to be able to write one. That is a sharp thing to
 * hand a web page, so the rules are narrow:
 *
 * - The file must be **outside the workspace**. Secrets are kept outside on
 *   purpose: that is the entire reason the jail stops the agent reading them.
 *   Writing them inside would put every key within reach of a tool the agent
 *   already has, so it is refused rather than trusted not to happen.
 * - Only known keys are written, so a request cannot set PATH or NODE_OPTIONS
 *   and turn a settings form into arbitrary code execution on the next start.
 * - The file is 0600. It holds credentials, and the default umask does not.
 * - Values are never read back out to the browser, only whether one is set and
 *   its last few characters, which is enough to tell two keys apart.
 */

/** Environment variables the dashboard is allowed to write. */
export const WRITABLE_SECRETS: Record<string, { label: string; hint: string }> = {
  OPENAI_API_KEY: { label: "OpenAI", hint: "sk-…" },
  ANTHROPIC_API_KEY: { label: "Anthropic", hint: "sk-ant-…" },
  KOS_SECRET_DISCORD: { label: "Discord bot token", hint: "for DMs" },
  KOS_OWNER_DISCORD: { label: "Discord owner id", hint: "your numeric user id" },
};

/** Non-secret settings that also live in the env file. */
export const WRITABLE_SETTINGS: Record<string, { label: string; hint: string }> = {
  KOS_PORT: { label: "Dashboard port", hint: "default 4317" },
  KOS_SITES_PORT: { label: "Sites port", hint: "default dashboard + 1, 0 to disable" },
};

export function isWritableKey(key: string): boolean {
  return key in WRITABLE_SECRETS || key in WRITABLE_SETTINGS;
}

/**
 * Whether a path is inside a directory. Used to keep the env file out of the
 * workspace, so this has to be right rather than approximately right.
 */
export function isInside(directory: string, path: string): boolean {
  const from = resolve(directory);
  const to = resolve(path);
  if (from === to) return true;
  const rel = relative(from, to);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** Parse a dotenv file into key/value pairs. Comments and blanks are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(line.slice(eq + 1).trim());
  }
  return out;
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

/** Quote a value if it needs it, so a token with a space survives a round trip. */
function quote(value: string): string {
  return /[\s"'#]/.test(value) ? JSON.stringify(value) : value;
}

/**
 * Enough of a secret to tell two apart, and not enough to use.
 *
 * The last four characters, which is the convention every provider's own
 * dashboard uses, so it reads as the same key you are looking at there.
 */
export function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

export interface WriteResult {
  written: string[];
  cleared: string[];
}

/**
 * Merge values into the env file, preserving everything else in it.
 *
 * Lines that are not being changed are left exactly as they were, comments
 * included: this is a file the owner may also edit by hand, and rewriting it
 * from a parsed map would quietly throw away their notes.
 */
export function writeEnvFile(
  path: string,
  workspaceRoot: string,
  values: Record<string, string | null>,
): WriteResult {
  if (isInside(workspaceRoot, path)) {
    throw new Error(
      `refusing to write secrets to ${path}: it is inside the workspace, ` +
        `where the agent can read it. Secrets belong outside.`,
    );
  }

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing === "" ? [] : existing.split("\n");
  const written: string[] = [];
  const cleared: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (!isWritableKey(key)) continue;
    const index = lines.findIndex((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("#") && trimmed.startsWith(`${key}=`);
    });

    if (value === null || value === "") {
      if (index >= 0) lines.splice(index, 1);
      cleared.push(key);
      continue;
    }
    const line = `${key}=${quote(value)}`;
    if (index >= 0) lines[index] = line;
    else lines.push(line);
    written.push(key);
  }

  const body = lines.join("\n").replace(/\n*$/, "\n");
  writeFileSync(path, body, { mode: 0o600 });
  try {
    // Set explicitly as well: writeFileSync only applies the mode when it
    // creates the file, so an existing world-readable .env would stay that way.
    chmodSync(path, 0o600);
  } catch {
    // A filesystem without permissions (a mounted volume) is not a reason to
    // fail the write; the file is still outside the workspace.
  }

  return { written, cleared };
}
