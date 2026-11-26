import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
 * The server's own home (its uv cache and downloads) sits beside it, so the
 * code that holds the tokens is not code a jailed program could rewrite.
 */

export interface GooglePlaces {
  root: string;
  /** The tokens: one `<email>.json` per account, written by the server. */
  credentials: string;
  /** The server's HOME and working folder. */
  home: string;
}

export function googlePlaces(env: NodeJS.ProcessEnv = process.env): GooglePlaces {
  const root = env.KOS_GOOGLE_DIR?.trim() || join(homedir(), ".kos", "google");
  return { root, credentials: join(root, "credentials"), home: join(root, "home") };
}

/** The folders made, and kept, for the owner's account alone. */
export function preparePlaces(places: GooglePlaces): void {
  for (const dir of [places.root, places.credentials, places.home]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  for (const file of readdirSync(places.credentials)) {
    const path = join(places.credentials, file);
    if (statSync(path).isFile()) chmodSync(path, 0o600);
  }
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

/**
 * The account the server signs in as. In single-user mode it uses the first
 * it finds, so that is the one shown.
 */
export function readAccount(places: GooglePlaces): GoogleAccount | undefined {
  for (const { email, path } of accountFiles(places)) {
    const token = readToken(path);
    if (!token) continue;
    const scopes = Array.isArray(token.scopes) ? token.scopes.filter((s): s is string => typeof s === "string").sort() : [];
    return { email, scopes, refreshable: typeof token.refresh_token === "string" && token.refresh_token !== "", savedAt: statSync(path).mtimeMs };
  }
  return undefined;
}

export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export type RevokeFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/**
 * Sign out for good: each held token revoked at Google (the refresh token,
 * which takes its access tokens with it), then every file in the folder
 * deleted, revoked or not, so nothing of the sign-in stays on disk. Says
 * whether Google confirmed every revoke.
 */
export async function disconnect(places: GooglePlaces, fetchFn: RevokeFetch): Promise<{ accounts: string[]; revoked: boolean }> {
  const accounts = accountFiles(places);
  let revoked = true;
  for (const { path } of accounts) {
    const token = readToken(path);
    const value = token?.refresh_token || token?.token;
    if (!value) continue;
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
  rmSync(places.credentials, { recursive: true, force: true });
  mkdirSync(places.credentials, { recursive: true, mode: 0o700 });
  return { accounts: accounts.map((a) => a.email), revoked };
}
