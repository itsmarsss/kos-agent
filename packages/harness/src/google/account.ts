import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the Google server keeps the owner's sign-in, and what it says.
 *
 * workspace-mcp stores OAuth tokens only as files (a local folder, or a
 * cloud bucket); it has no store KOS could hand it the vault through. So
 * they live in a folder of KOS's own under ~/.kos: outside the workspace,
 * 0700 with each file 0600, and denied to every jailed program (the shell,
 * skills, Python) with the rest of ~/.kos. Nothing a guest reaches reads it.
 * The server's own home (its uv cache), logs and downloads sit beside it, and
 * so do the owner's switches: a file no sql statement can write.
 */

export interface GooglePlaces {
  root: string;
  /** The tokens: one `<email>.json` per account, written by the server. */
  credentials: string;
  /** The server's HOME and working folder. */
  home: string;
  logs: string;
  attachments: string;
  tmp: string;
  /** The owner's switches and the account they signed in as. */
  settings: string;
}

/** Where Google sends the browser back after sign-in, on this computer only; KOS_GOOGLE_PORT moves it. No jailed program may bind or reach it. */
export function googlePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KOS_GOOGLE_PORT);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : 4327;
}

/** Where KOS keeps it: `~/.kos/google`, or KOS_GOOGLE_DIR, which the jail denies as it does ~/.kos (jail.ts, kosSecretFiles). */
export function googleDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KOS_GOOGLE_DIR?.trim() || join(homedir(), ".kos", "google");
}

export function googlePlaces(env: NodeJS.ProcessEnv = process.env): GooglePlaces {
  const root = googleDir(env);
  return {
    root,
    credentials: join(root, "credentials"),
    home: join(root, "home"),
    logs: join(root, "logs"),
    attachments: join(root, "attachments"),
    tmp: join(root, "tmp"),
    settings: join(root, "settings.json"),
  };
}

/** A log past this is cut back to nothing when the server next starts: it has no rotation of its own. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** The folders made, and kept, for the owner's account alone; a log grown too big emptied. */
export function preparePlaces(places: GooglePlaces): void {
  for (const dir of [places.root, places.credentials, places.home, places.logs, places.attachments, places.tmp]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  for (const file of readdirSync(places.credentials)) {
    const path = join(places.credentials, file);
    if (statSync(path).isFile()) chmodSync(path, 0o600);
  }
  for (const file of readdirSync(places.logs)) {
    const path = join(places.logs, file);
    if (statSync(path).isFile() && statSync(path).size > LOG_MAX_BYTES) truncateSync(path, 0);
  }
}

export interface StoredSettings {
  on?: unknown;
  changes?: unknown;
  send?: unknown;
  /** The address the owner signs in as; any other account's sign-in is refused. */
  email?: unknown;
}

export function readSettingsFile(places: GooglePlaces): StoredSettings {
  try {
    const parsed = JSON.parse(readFileSync(places.settings, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredSettings) : {};
  } catch {
    return {};
  }
}

export function writeSettingsFile(places: GooglePlaces, value: StoredSettings): void {
  mkdirSync(places.root, { recursive: true, mode: 0o700 });
  writeFileSync(places.settings, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(places.settings, 0o600);
}

/** The signed-in account, as the owner is shown it: never a token. */
export interface GoogleAccount {
  email: string;
  scopes: string[];
  /** A refresh token is held, so the sign-in outlives its first hour. */
  refreshable: boolean;
  /** When the server last wrote the sign-in (a new sign-in, or a refreshed token). */
  savedAt: number;
}

interface TokenFile {
  token?: string | null;
  refresh_token?: string | null;
  scopes?: unknown;
}

/** The token files, by account: `<url-encoded email>.json`, skipping the server's own state file. */
function accountFiles(places: GooglePlaces): { email: string; path: string }[] {
  if (!existsSync(places.credentials)) return [];
  return readdirSync(places.credentials)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ email: safeDecode(f.slice(0, -".json".length)), path: join(places.credentials, f) }))
    .filter((a) => a.email.includes("@"))
    .sort((a, b) => a.email.localeCompare(b.email));
}

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function readToken(path: string): TokenFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TokenFile) : undefined;
  } catch {
    return undefined;
  }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The sign-in of one account (the one the owner expects), or of any when none is named. */
export function readAccount(places: GooglePlaces, email?: string): GoogleAccount | undefined {
  for (const file of accountFiles(places)) {
    if (email !== undefined && !same(file.email, email)) continue;
    const token = readToken(file.path);
    if (!token) continue;
    const scopes = Array.isArray(token.scopes) ? token.scopes.filter((s): s is string => typeof s === "string").sort() : [];
    return { email: file.email, scopes, refreshable: typeof token.refresh_token === "string" && token.refresh_token !== "", savedAt: statSync(file.path).mtimeMs };
  }
  return undefined;
}

/** Every account signed in but the one named: a sign-in the owner did not ask for. */
export function otherAccounts(places: GooglePlaces, email: string | undefined): string[] {
  return accountFiles(places)
    .filter((f) => email === undefined || !same(f.email, email))
    .map((f) => f.email);
}

export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type RevokeFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/**
 * Revoke at Google and delete the token files of the accounts named, or of
 * all. Says whether Google confirmed every revoke; the files go either way.
 */
export async function forget(places: GooglePlaces, fetchFn: RevokeFetch, only?: string[]): Promise<{ accounts: string[]; revoked: boolean }> {
  const files = accountFiles(places).filter((f) => !only || only.some((e) => same(e, f.email)));
  let revoked = true;
  for (const { path } of files) {
    const token = readToken(path);
    const value = token?.refresh_token || token?.token;
    if (value) {
      try {
        const res = await fetchFn(REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: value }).toString(),
        });
        // 400 is Google's answer for a token already revoked or expired: gone either way.
        if (!res.ok && res.status !== 400) revoked = false;
      } catch {
        revoked = false;
      }
    }
    rmSync(path, { force: true });
  }
  return { accounts: files.map((f) => f.email), revoked };
}

/**
 * Sign out for good: every token revoked and deleted, and with them the
 * server's logs, downloads and state, so nothing of the account stays on
 * disk. The switches stay; the account the owner expected goes.
 */
export async function disconnect(places: GooglePlaces, fetchFn: RevokeFetch): Promise<{ accounts: string[]; revoked: boolean }> {
  const done = await forget(places, fetchFn);
  for (const dir of [places.credentials, places.logs, places.attachments, places.tmp]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const { email: _gone, ...kept } = readSettingsFile(places);
  writeSettingsFile(places, kept);
  return done;
}
