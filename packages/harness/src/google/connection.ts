import { existsSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { renderContent, type McpServerConfig } from "../tools/mcp.js";
import { childEnv } from "../sandbox/env.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { SettingsStore } from "../store/settings.js";
import { disconnect, googlePlaces, preparePlaces, readAccount, type GoogleAccount, type GooglePlaces, type RevokeFetch } from "./account.js";
import { parseClientJson, readClient, storeClient, vaultProblem, type GoogleClient } from "./client.js";
import { googleToolRisk } from "./risk.js";

/**
 * The owner's Google account (Calendar, Gmail, Drive, Docs) through the
 * community workspace-mcp server, run with uvx as KOS's other Python servers
 * are, pinned to one release.
 *
 * Read-only until the owner allows changes, and sending mail is a switch of
 * its own past that: each mode is the server started with only that mode's
 * Google scopes and tools, so what KOS was not allowed is not there to call.
 * Whatever runs is judged per tool (risk.ts) and its results fenced as
 * outside text.
 */

export const GOOGLE_SERVER = "google";
/** The release KOS runs: a newer one changes tools, and its tools ask until risk.ts knows them. */
export const WORKSPACE_MCP = "workspace-mcp==2.7.0";
export const GOOGLE_SERVICES = ["calendar", "gmail", "drive", "docs"] as const;
/** Where Google sends the browser back after sign-in, on this computer only. */
export const GOOGLE_CALLBACK_PORT = 4327;
export const SETTINGS_KEY = "google";
/** How long a sign-in waits for the owner in the browser. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;

export interface GoogleSettings {
  /** Use the account at all; off keeps the sign-in and stops the server. */
  on: boolean;
  /** Creating, editing and deleting, not only reading. */
  changes: boolean;
  /** Sending mail. Only with changes. */
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

/** Each service's level on the server: read-only, or full with Gmail stopping short of send unless it is allowed. */
export function permissionArgs(settings: GoogleSettings): string[] {
  const gmail = !settings.changes ? "readonly" : settings.send ? "send" : "drafts";
  const rest = settings.changes ? "full" : "readonly";
  return ["--permissions", `gmail:${gmail}`, `calendar:${rest}`, `drive:${rest}`, `docs:${rest}`];
}

const G = "https://www.googleapis.com/auth/";

/** The scopes a mode signs in for, as the server asks for them (auth/permissions.py of the pinned release). */
export function scopesFor(settings: GoogleSettings): string[] {
  const read = ["gmail.readonly", "calendar.readonly", "drive.readonly", "documents.readonly"];
  const changes = ["gmail.labels", "gmail.modify", "gmail.compose", "calendar", "calendar.events", "drive", "drive.file", "documents"];
  return [...read, ...(settings.changes ? changes : []), ...(settings.send ? ["gmail.send"] : [])].map((s) => `${G}${s}`);
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
  settings: GoogleSettings;
  /** Scopes the mode needs that the sign-in lacks. */
  missing: string[];
  signingIn: boolean;
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
  settings: SettingsStore;
  secrets: SecretsRegistry;
  places?: GooglePlaces;
  port?: number;
  /** Bring up a server for a sign-in. Defaults to spawning it; a test supplies one. */
  authSession?: (config: McpServerConfig) => Promise<AuthSession>;
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

export function presentResult(text: string): string {
  return /ACTION REQUIRED: Google Authentication|Authorization URL:/.test(text) ? SIGN_IN_AGAIN : text;
}

export class GoogleConnection {
  readonly places: GooglePlaces;
  readonly port: number;
  private signingIn = false;
  private session: AuthSession | undefined;
  private timer: NodeJS.Timeout | undefined;
  private failure: string | undefined;
  private readonly listeners = new Set<() => unknown>();

  constructor(private readonly options: GoogleConnectionOptions) {
    this.places = options.places ?? googlePlaces();
    this.port = options.port ?? GOOGLE_CALLBACK_PORT;
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
    return parseSettings(this.options.settings.get(SETTINGS_KEY));
  }

  /** Change the mode, and bring the server up again in it. */
  async setSettings(patch: Partial<GoogleSettings>): Promise<GoogleSettings> {
    const next = parseSettings({ ...this.settings(), ...patch });
    this.options.settings.set(SETTINGS_KEY, next);
    await this.changed();
    return next;
  }

  account(): GoogleAccount | undefined {
    return readAccount(this.places);
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
      settings,
      missing: account ? missingScopes(scopesFor(settings), account.scopes) : [],
      signingIn: this.signingIn,
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
   * The server for the mcp module, or none: only with a client, a signed-in
   * account and the switch on, and never while a sign-in holds the callback
   * port.
   */
  server(): McpServerConfig | undefined {
    const client = readClient(this.options.secrets);
    const account = this.account();
    if (!client || !account || this.signingIn || !this.settings().on) return undefined;
    return {
      ...this.spawnConfig(client, this.settings(), account.email),
      untrusted: true,
      risks: googleToolRisk,
      results: presentResult,
    };
  }

  /**
   * What the server is started with. Its home and working folder are KOS's
   * Google folder, so the uv cache it runs from is out of the workspace too;
   * it may not read local files to upload them; it never opens a browser
   * itself (BROWSER runs `true`, which Python takes as opened); and its
   * own sign-in tool is withheld from the model.
   */
  private spawnConfig(client: GoogleClient, settings: GoogleSettings, email: string | undefined, withAuthTool = false): McpServerConfig {
    preparePlaces(this.places);
    return {
      command: "uvx",
      args: [WORKSPACE_MCP, "--single-user", ...permissionArgs(settings), ...(withAuthTool ? [] : ["--disabled-tools", "start_google_auth"])],
      cwd: this.places.home,
      env: {
        HOME: this.places.home,
        USERPROFILE: this.places.home,
        GOOGLE_OAUTH_CLIENT_ID: client.id,
        GOOGLE_OAUTH_CLIENT_SECRET: client.secret,
        GOOGLE_OAUTH_REDIRECT_URI: redirectUri(this.port),
        WORKSPACE_MCP_PORT: String(this.port),
        WORKSPACE_MCP_CREDENTIALS_DIR: this.places.credentials,
        WORKSPACE_MCP_DISABLE_LOCAL_FILES: "true",
        OAUTHLIB_INSECURE_TRANSPORT: "1",
        BROWSER: "true",
        ...(email ? { USER_GOOGLE_EMAIL: email } : {}),
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
  async signIn(): Promise<{ url: string }> {
    if (this.signingIn) throw new Error("a Google sign-in is already waiting in the browser");
    const client = readClient(this.options.secrets);
    if (!client) throw new Error(`import the Google OAuth client first${vaultProblem(this.options.secrets) ? `: ${vaultProblem(this.options.secrets)}` : ""}`);
    this.failure = undefined;
    const before = this.account()?.savedAt;
    this.signingIn = true;
    await this.changed();
    try {
      const session = await (this.options.authSession ?? spawnAuthSession)(this.spawnConfig(client, this.settings(), this.account()?.email, true));
      this.session = session;
      const said = await session.start();
      const url = authUrlIn(said);
      if (!url) throw new Error(`the Google server gave no sign-in address${said.trim() ? `: ${said.trim().slice(0, 300)}` : ""}`);
      this.wait(before);
      return { url };
    } catch (err) {
      await this.endSignIn(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Look for a token file newer than the one before, until one is written or the wait runs out. */
  private wait(before: number | undefined): void {
    const started = Date.now();
    const tick = (): void => {
      const saved = this.account()?.savedAt;
      if (saved !== undefined && saved !== before) return void this.endSignIn();
      if (Date.now() - started >= (this.options.waitMs ?? SIGN_IN_WAIT_MS)) return void this.endSignIn("the sign-in was not finished in the browser in time; start it again");
      this.timer = setTimeout(tick, this.options.pollMs ?? 1000);
    };
    this.timer = setTimeout(tick, this.options.pollMs ?? 1000);
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
    this.failure = undefined;
    const done = await disconnect(this.places, this.options.fetch ?? (fetch as unknown as RevokeFetch));
    await this.changed();
    return done;
  }

  /** Let go of a waiting sign-in, at shutdown. */
  async close(): Promise<void> {
    await this.stopSignIn();
  }
}

/** The sign-in server, spawned as the tool server is, with the same environment hygiene. */
async function spawnAuthSession(config: McpServerConfig): Promise<AuthSession> {
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
      const result = await client.callTool({ name: "start_google_auth", arguments: { service_name: "Google Workspace", user_google_email: "default" } });
      return renderContent(result.content);
    },
    close: () => client.close(),
  };
}
