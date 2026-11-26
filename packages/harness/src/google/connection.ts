import { existsSync, readdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { renderContent, type McpServerConfig } from "../tools/mcp.js";
import { childEnv, findProgram } from "../sandbox/env.js";
import { isContained, jailedProgram, kosPorts, kosSecretFiles } from "../sandbox/jail.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import { realOf } from "../secrets/vault.js";
import {
  disconnect,
  forget,
  googlePlaces,
  googlePort,
  otherAccounts,
  preparePlaces,
  readAccount,
  readSettingsFile,
  serverDirs,
  writeSettingsFile,
  type GoogleAccount,
  type GooglePlaces,
  type RevokeFetch,
} from "./account.js";
import { parseClientJson, readClient, storeClient, vaultProblem, type GoogleClient } from "./client.js";
import { googleToolRisk } from "./risk.js";

/**
 * The owner's Google account (Calendar, Gmail, Drive, Docs) through the
 * community workspace-mcp server, run with uvx as KOS's other Python servers
 * are, pinned to one release.
 *
 * Read-only until the owner allows changes, which open Calendar, Drive and
 * Docs and leave Gmail read-only. Writing mail at all (drafts, labels,
 * sending) is a switch of its own past that, since Google has no scope that
 * drafts or labels without also letting messages be sent (gmail.compose and
 * gmail.modify both allow messages.send). Each mode is the server started
 * with only that mode's scopes and tools, so what KOS was not allowed is not
 * there to call. Whatever runs is judged per tool (risk.ts), and its
 * results are fenced as outside text.
 *
 * The server runs in KOS's jail where KOS has one: the network open, KOS's
 * own ports shut, writes only to its Google folder, the rest of the owner's
 * home unreadable. Its dependencies are frozen to what was published on the
 * day this release was pinned.
 */

export const GOOGLE_SERVER = "google";
/** The release KOS runs: a newer one changes tools, and its tools ask until risk.ts knows them. */
export const WORKSPACE_MCP = "workspace-mcp==2.7.0";
/** Its dependencies as they were when it was pinned: nothing published later is resolved. */
export const RESOLVED_BEFORE = "2026-11-25T00:00:00Z";
export const GOOGLE_SERVICES = ["calendar", "gmail", "drive", "docs"] as const;
/** Where Google sends the browser back after sign-in, on this computer only. */
export const GOOGLE_CALLBACK_PORT = googlePort({});
/** A file the server reads or writes, at most: an attachment, an upload, a download. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** How long a sign-in waits for the owner in the browser. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;

export interface GoogleSettings {
  /** Use the account at all; off keeps the sign-in and stops the server. */
  on: boolean;
  /** Creating, editing and deleting in Calendar, Drive and Docs. */
  changes: boolean;
  /** Writing mail: drafts, labels and sending. Only with changes. */
  send: boolean;
}

export const DEFAULT_SETTINGS: GoogleSettings = { on: true, changes: false, send: false };

export function parseSettings(raw: unknown): GoogleSettings {
  const v = typeof raw === "object" && raw !== null ? (raw as Partial<Record<keyof GoogleSettings, unknown>>) : {};
  const changes = v.changes === true;
  return { on: v.on !== false, changes, send: changes && v.send === true };
}

export function redirectUri(port: number): string {
  return `http://localhost:${port}/oauth2callback`;
}

/** Each service's level on the server: read-only, or full, with Gmail read-only until mail may be written and sent. */
export function permissionArgs(settings: GoogleSettings): string[] {
  const gmail = settings.send ? "send" : "readonly";
  const rest = settings.changes ? "full" : "readonly";
  return ["--permissions", `gmail:${gmail}`, `calendar:${rest}`, `drive:${rest}`, `docs:${rest}`];
}

const G = "https://www.googleapis.com/auth/";

/** The scopes a mode signs in for, as the server asks for them (auth/permissions.py of the pinned release). */
export function scopesFor(settings: GoogleSettings): string[] {
  const read = ["gmail.readonly", "calendar.readonly", "drive.readonly", "documents.readonly"];
  const changes = ["calendar", "calendar.events", "drive", "drive.file", "documents"];
  const mail = ["gmail.labels", "gmail.modify", "gmail.compose", "gmail.send"];
  return [...read, ...(settings.changes ? changes : []), ...(settings.send ? mail : [])].map((s) => `${G}${s}`);
}

/** Broader scopes and the narrower ones each covers, as Google grants them. */
const COVERS: Record<string, string[]> = {
  [`${G}gmail.modify`]: ["gmail.readonly", "gmail.send", "gmail.compose", "gmail.labels"].map((s) => `${G}${s}`),
  [`${G}drive`]: [`${G}drive.readonly`, `${G}drive.file`],
  [`${G}calendar`]: [`${G}calendar.readonly`, `${G}calendar.events`],
  [`${G}documents`]: [`${G}documents.readonly`],
};

/** The scopes a mode needs that the sign-in does not cover: a reason to sign in again. */
export function missingScopes(needed: string[], granted: string[]): string[] {
  const have = new Set(granted.flatMap((s) => [s, ...(COVERS[s] ?? [])]));
  return needed.filter((s) => !have.has(s));
}

export interface GoogleStatus {
  /** The client's id, never its secret; null when none is kept. */
  client: { id: string } | null;
  /** Why the client cannot be read now (a locked vault). */
  vault?: string;
  account: GoogleAccount | null;
  /** The address the owner signs in as, once they have said it. */
  email: string | null;
  settings: GoogleSettings;
  /** Scopes the mode needs that the sign-in lacks. */
  missing: string[];
  signingIn: boolean;
  /** What holds the server: KOS's jail, the container, or nothing (said to the owner); null before it first starts. */
  jail: JailKind | null;
  /** Why the server is not jailed, or would not start because it could not be. */
  jailProblem?: string;
  /** The last sign-in's failure, in words. */
  error?: string;
  redirectUri: string;
}

/** A server brought up for one sign-in: it opens the address the browser goes to, and closes after. */
export interface AuthSession {
  /** The server's answer to start_google_auth. */
  start(): Promise<string>;
  close(): Promise<void>;
}

export interface GoogleConnectionOptions {
  secrets: SecretsRegistry;
  places?: GooglePlaces;
  port?: number;
  /** Bring up a server for a sign-in. Defaults to spawning it; a test supplies one. */
  authSession?: (config: McpServerConfig, email: string) => Promise<AuthSession>;
  /** For revoking at Google. Defaults to fetch. */
  fetch?: RevokeFetch;
  /** How often a sign-in looks for the token file, and how long it waits. */
  pollMs?: number;
  waitMs?: number;
}

/** The sign-in address in the server's answer. */
export function authUrlIn(text: string): string | undefined {
  return /Authorization URL:\s*(https:\/\/accounts\.google\.com\/\S+)/.exec(text)?.[1];
}

/** What a result asking to sign in says instead: the owner signs in from Settings, never from a link in a chat. */
export const SIGN_IN_AGAIN =
  "Google is not signed in, or its sign-in lapsed (a Google app in Testing signs out after 7 days). Nothing was done. The owner signs in again under Settings > Connections, or with kos google signin.";

export type JailKind = "kos" | "container" | "none";

/** The server's own sign-in prompts, at the start of a result or of a tool error naming the tool. */
const SIGN_IN_PROMPT = /^\s*(?:Error calling tool '[a-z_]+': )?\*\*(?:ACTION REQUIRED: Google Authentication Needed|Authentication Required: Token Expired\/Revoked)\b/;

/**
 * A result as the model reads it: the server's sign-in prompt, or any text
 * carrying a Google sign-in address for the owner's own client (should the
 * prompt's wording change), becomes words sending the owner to Settings.
 */
export function presentResult(text: string, clientId?: string): string {
  if (SIGN_IN_PROMPT.test(text)) return SIGN_IN_AGAIN;
  if (clientId && /https:\/\/accounts\.google\.com\/o\/oauth2\//.test(text) && (text.includes(`client_id=${clientId}`) || text.includes(`client_id=${encodeURIComponent(clientId)}`))) return SIGN_IN_AGAIN;
  return text;
}

/** An address as the owner would type it, or undefined. */
export function addressOf(value: unknown): string | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
}

export class GoogleConnection {
  readonly places: GooglePlaces;
  readonly port: number;
  private signingIn = false;
  private session: AuthSession | undefined;
  private timer: NodeJS.Timeout | undefined;
  private failure: string | undefined;
  private jail: { kind: JailKind; problem?: string } | undefined;
  private watcher: FSWatcher | undefined;
  private readonly listeners = new Set<() => unknown>();

  constructor(private readonly options: GoogleConnectionOptions) {
    this.places = options.places ?? googlePlaces();
    this.port = options.port ?? googlePort();
  }

  /** Told when what the server should be changes, and awaited: the MCP set is reloaded from here. */
  onChange(listener: () => unknown): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async changed(): Promise<void> {
    for (const listener of this.listeners) await listener();
  }

  settings(): GoogleSettings {
    return parseSettings(readSettingsFile(this.places));
  }

  /** Change the mode, and bring the server up again in it. Kept beside the tokens, where no sql statement reaches. */
  async setSettings(patch: Partial<GoogleSettings>): Promise<GoogleSettings> {
    const next = parseSettings({ ...this.settings(), ...patch });
    writeSettingsFile(this.places, { ...readSettingsFile(this.places), ...next });
    await this.changed();
    return next;
  }

  /** The address the owner signs in as. */
  email(): string | undefined {
    return addressOf(readSettingsFile(this.places).email);
  }

  /** The sign-in of the owner's own address; none until they have said which it is. */
  account(): GoogleAccount | undefined {
    const email = this.email();
    return email ? readAccount(this.places, email) : undefined;
  }

  status(): GoogleStatus {
    const client = readClient(this.options.secrets);
    const problem = client ? undefined : vaultProblem(this.options.secrets);
    const account = this.account() ?? null;
    const settings = this.settings();
    return {
      client: client ? { id: client.id } : null,
      ...(problem ? { vault: problem } : {}),
      account,
      email: this.email() ?? null,
      settings,
      missing: account ? missingScopes(scopesFor(settings), account.scopes) : [],
      signingIn: this.signingIn,
      jail: this.jail?.kind ?? null,
      ...(this.jail?.problem ? { jailProblem: this.jail.problem } : {}),
      ...(this.failure ? { error: this.failure } : {}),
      redirectUri: redirectUri(this.port),
    };
  }

  /** The client from Google Cloud's JSON, into the vault. */
  importClient(json: unknown): { id: string } {
    const client = parseClientJson(json, redirectUri(this.port));
    storeClient(this.options.secrets, client);
    return { id: client.id };
  }

  /**
   * The server for the mcp module, or none: only with a client, the owner's
   * own account signed in and the switch on, and never while a sign-in holds
   * the callback port. A token file for any other account is deleted first:
   * the server would use it, and the owner never asked for it.
   */
  server(): McpServerConfig | undefined {
    const client = readClient(this.options.secrets);
    const account = this.account();
    if (!client || !account || this.signingIn || !this.settings().on) return undefined;
    this.dropOthers();
    let spawn: McpServerConfig;
    try {
      spawn = this.spawnConfig(client, this.settings(), account.email);
    } catch (err) {
      // No jail where there must be one: the server does not start.
      this.jail = { kind: "none", problem: err instanceof Error ? err.message : String(err) };
      return undefined;
    }
    this.watchCredentials();
    return {
      ...spawn,
      untrusted: true,
      risks: (tool) => googleToolRisk(tool, () => this.email()),
      results: (text) => presentResult(text, client.id),
    };
  }

  /** Revoke and delete every sign-in but the owner's, unless a sign-in is under way (it judges its own). */
  private dropOthers(): void {
    if (this.signingIn) return;
    const others = otherAccounts(this.places, this.email());
    if (others.length) void forget(this.places, this.revokeFetch(), others);
  }

  /** While the server runs, a token for any other account landing in its folder is dropped at once. */
  private watchCredentials(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.places.credentials, () => this.dropOthers());
      this.watcher.on("error", () => this.unwatch());
    } catch {
      this.watcher = undefined;
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * What the server is started with. Its home, working folder, temp, logs
   * and downloads are KOS's Google folder, so the uv cache it runs from is
   * out of the workspace too; it may not read local files to upload them;
   * it never opens a browser itself (BROWSER runs `true`, which Python takes
   * as opened); it uses only the owner's own account (USER_GOOGLE_EMAIL); and
   * its own sign-in tool is withheld from the model.
   */
  private spawnConfig(client: GoogleClient, settings: GoogleSettings, email: string, withAuthTool = false): McpServerConfig {
    preparePlaces(this.places);
    const args = ["--exclude-newer", RESOLVED_BEFORE, WORKSPACE_MCP, "--single-user", ...permissionArgs(settings), ...(withAuthTool ? [] : ["--disabled-tools", "start_google_auth"])];
    const run = jailed(this.places, this.port, args);
    if (run.jail === "none" && this.jail?.kind !== "none") console.warn(`[google] running without the jail: ${run.problem ?? "none on this computer"}`);
    this.jail = { kind: run.jail, ...(run.problem ? { problem: run.problem } : {}) };
    return {
      command: run.command,
      args: run.args,
      cwd: this.places.home,
      env: {
        HOME: this.places.home,
        USERPROFILE: this.places.home,
        TMPDIR: this.places.tmp,
        GOOGLE_OAUTH_CLIENT_ID: client.id,
        GOOGLE_OAUTH_CLIENT_SECRET: client.secret,
        GOOGLE_OAUTH_REDIRECT_URI: redirectUri(this.port),
        WORKSPACE_MCP_PORT: String(this.port),
        WORKSPACE_MCP_CREDENTIALS_DIR: this.places.credentials,
        WORKSPACE_MCP_LOG_DIR: this.places.logs,
        WORKSPACE_MCP_LOG_LEVEL: "WARNING",
        WORKSPACE_ATTACHMENT_DIR: this.places.attachments,
        WORKSPACE_MCP_MAX_FILE_BYTES: String(MAX_FILE_BYTES),
        WORKSPACE_MCP_DISABLE_LOCAL_FILES: "true",
        OAUTHLIB_INSECURE_TRANSPORT: "1",
        BROWSER: "true",
        USER_GOOGLE_EMAIL: email,
      },
    };
  }

  /**
   * Sign in: the tool server is taken down (it would hold the callback
   * port), a server of the same mode is brought up for the sign-in alone,
   * and the address it gives is handed back for the owner's browser. It
   * waits there for Google to send the browser back; once the token file
   * is written it closes, and the tool server comes up signed in.
   */
  async signIn(address?: string): Promise<{ url: string }> {
    if (this.signingIn) throw new Error("a Google sign-in is already waiting in the browser");
    const client = readClient(this.options.secrets);
    if (!client) throw new Error(`import the Google OAuth client first${vaultProblem(this.options.secrets) ? `: ${vaultProblem(this.options.secrets)}` : ""}`);
    const kept = this.email();
    const email = address === undefined || address === "" ? kept : addressOf(address);
    if (!email) throw new Error(address ? `${address} is not an email address` : "say which Google address to sign in as");
    if (kept && kept !== email) throw new Error(`KOS is signed in as ${kept}; disconnect first to use ${email}`);
    this.failure = undefined;
    writeSettingsFile(this.places, { ...readSettingsFile(this.places), email });
    const before = this.account()?.savedAt;
    this.signingIn = true;
    await this.changed();
    try {
      const session = await (this.options.authSession ?? spawnAuthSession)(this.spawnConfig(client, this.settings(), email, true), email);
      this.session = session;
      const said = await session.start();
      const url = authUrlIn(said);
      if (!url) throw new Error(`the Google server gave no sign-in address${said.trim() ? `: ${said.trim().slice(0, 300)}` : ""}`);
      this.wait(email, before);
      return { url };
    } catch (err) {
      await this.endSignIn(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Look for the owner's token file, newer than the one before, until it is
   * written or the wait runs out. A sign-in as any other account is revoked
   * and deleted the moment it lands, and the sign-in fails saying so.
   */
  private wait(email: string, before: number | undefined): void {
    const started = Date.now();
    const tick = (): void => {
      const others = otherAccounts(this.places, email);
      if (others.length) {
        void forget(this.places, this.revokeFetch(), others).then(() =>
          this.endSignIn(`Google signed in as ${others.join(", ")}, not ${email}; that sign-in was revoked and deleted. Sign in again as ${email}.`),
        );
        return;
      }
      const saved = this.account()?.savedAt;
      if (saved !== undefined && saved !== before) return void this.endSignIn();
      if (Date.now() - started >= (this.options.waitMs ?? SIGN_IN_WAIT_MS)) return void this.endSignIn("the sign-in was not finished in the browser in time; start it again");
      this.timer = setTimeout(tick, this.options.pollMs ?? 1000);
    };
    this.timer = setTimeout(tick, this.options.pollMs ?? 1000);
  }

  private revokeFetch(): RevokeFetch {
    return this.options.fetch ?? (fetch as unknown as RevokeFetch);
  }

  /** Close the sign-in server, keep why it failed if it did, and bring the tool server back. */
  private async endSignIn(failure?: string): Promise<void> {
    if (!this.signingIn) return;
    await this.stopSignIn();
    this.failure = failure;
    if (existsSync(this.places.credentials)) preparePlaces(this.places);
    await this.changed();
  }

  private async stopSignIn(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const session = this.session;
    this.session = undefined;
    this.signingIn = false;
    await session?.close().catch(() => undefined);
  }

  /** Revoke the sign-in at Google and delete its tokens. The client stays in the vault for the next sign-in. */
  async disconnect(): Promise<{ accounts: string[]; revoked: boolean }> {
    await this.stopSignIn();
    this.unwatch();
    this.failure = undefined;
    const done = await disconnect(this.places, this.revokeFetch());
    await this.changed();
    return done;
  }

  /** Let go of a waiting sign-in, at shutdown. */
  async close(): Promise<void> {
    this.unwatch();
    await this.stopSignIn();
  }
}

/**
 * The server's command, in KOS's jail where there is one: the network open
 * (it talks to Google), KOS's own ports shut but the callback's, writes only
 * inside the server's own folders (never their own entries, so none can be
 * swapped for a link), the owner's home unreadable but for uv and
 * uvx themselves, and every other secret of KOS's (the vault, the rest of
 * ~/.kos, the owner's switches) denied. In the container the container is
 * the jail. On macOS a jail that cannot be set up stops the server; on a
 * Linux without bubblewrap it runs without one, and the owner is told.
 */
export function jailed(
  places: GooglePlaces,
  port: number,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  contained = isContained(),
): { command: string; args: string[]; jail: JailKind; problem?: string } {
  const uvx = findProgram("uvx", childEnv({ home: places.home }).PATH ?? "");
  if (contained) return { command: uvx ?? "uvx", args, jail: "container" };
  const refuse = (problem: string): { command: string; args: string[]; jail: JailKind; problem: string } => {
    if (platform === "darwin") throw new Error(`the Google server needs KOS's jail, and ${problem}`);
    return { command: uvx ?? "uvx", args, jail: "none", problem };
  };
  if (!uvx) return refuse("uvx is not installed (https://docs.astral.sh/uv/)");
  const own = resolve(homedir(), ".kos");
  const root = resolve(places.root);
  const secretFiles = kosSecretFiles().flatMap((p) => (p === own && root.startsWith(`${own}/`) ? readdirSync(own).map((n) => join(own, n)).filter((n) => n !== root) : p === root ? [] : [p]));
  const uv = join(dirname(uvx), "uv");
  try {
    const cmd = jailedProgram(uvx, args, {
      workspaceRoot: places.root,
      writes: serverDirs(places),
      // Each folder's own entry is not the server's: it may write inside, never remove the folder or put a link in its place.
      unwritable: serverDirs(places).map((d) => `^${regexOf(realOf(d))}$`),
      reads: [realpathSync(uvx), ...(existsSync(uv) ? [realpathSync(uv)] : [])],
      network: true,
      kosPorts: kosPorts().filter((p) => p !== port),
      secretFiles,
      platform,
      contained,
    });
    return { command: cmd.file, args: cmd.args, jail: "kos" };
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
}

/** A path as a regex matching it exactly, for the jail's rules. */
function regexOf(path: string): string {
  return path.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

/** The sign-in server, spawned as the tool server is, with the same environment hygiene. */
async function spawnAuthSession(config: McpServerConfig, email: string): Promise<AuthSession> {
  const env = config.env ?? {};
  const client = new Client({ name: "kos", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      env: childEnv({ home: env["HOME"] ?? config.cwd! }, env),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      stderr: "ignore",
    }),
  );
  return {
    start: async () => {
      const result = await client.callTool({ name: "start_google_auth", arguments: { service_name: "Google Workspace", user_google_email: email } });
      return renderContent(result.content);
    },
    close: () => client.close(),
  };
}
