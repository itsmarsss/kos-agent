import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecretsRegistry } from "../secrets/secrets.js";
import { Vault } from "../secrets/vault.js";
import { googlePlaces, readSettingsFile, writeSettingsFile } from "./account.js";
import { GOOGLE_HARNESS } from "./client.js";
import { GoogleConnection, RESOLVED_BEFORE, SIGN_IN_AGAIN, WORKSPACE_MCP, jailed, missingScopes, permissionArgs, presentResult, scopesFor, type AuthSession } from "./connection.js";

const CLIENT = { installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-not-a-real-secret-0000" } };
const URL_SAID = "**ACTION REQUIRED**\n   Authorization URL: https://accounts.google.com/o/oauth2/auth?client_id=123&state=s\n2. ...";

let root: string;
let vault: Vault;
let secrets: SecretsRegistry;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kos-google-")));
  vault = new Vault({ dir: join(root, "secrets") });
  await vault.init();
  secrets = new SecretsRegistry();
  secrets.attachVault(vault);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function connection(extra: Partial<ConstructorParameters<typeof GoogleConnection>[0]> = {}): GoogleConnection {
  return new GoogleConnection({ secrets, places: googlePlaces({ KOS_GOOGLE_DIR: join(root, "google") }), pollMs: 5, waitMs: 2000, ...extra });
}

/** The token file the server writes once Google sends the browser back; `owner` also records it as the address the owner chose. */
function signInAs(c: GoogleConnection, email: string, scopes: string[], owner = true): void {
  mkdirSync(c.places.credentials, { recursive: true });
  if (owner) writeSettingsFile(c.places, { ...readSettingsFile(c.places), email });
  writeFileSync(join(c.places.credentials, `${email}.json`), JSON.stringify({ token: "ya29.x", refresh_token: "1//r", scopes }), { mode: 0o600 });
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("the Google client", () => {
  it("goes into the vault as KOS's google key, never a file, and is shown by its id alone", () => {
    const c = connection();
    expect(c.importClient(CLIENT)).toEqual({ id: CLIENT.installed.client_id });
    const kept = vault.harness(GOOGLE_HARNESS)!;
    expect(kept.kind).toBe("apikey");
    expect(vault.value(kept.handle, "token")).toBe(CLIENT.installed.client_secret);
    expect(vault.value(kept.handle, "username")).toBe(CLIENT.installed.client_id);
    expect(existsSync(join(root, "google"))).toBe(false);
    expect(JSON.stringify(c.status())).not.toContain(CLIENT.installed.client_secret);
    // A second import replaces the first.
    c.importClient({ installed: { ...CLIENT.installed, client_secret: "GOCSPX-second-one-000000" } });
    expect(vault.list().filter((m) => m.use.harness === GOOGLE_HARNESS)).toHaveLength(1);
  });

  it("refuses what is not a client, and a Web client without KOS's redirect address", () => {
    const c = connection();
    expect(() => c.importClient({ hello: 1 })).toThrow(/client_id/);
    expect(() => c.importClient({ installed: { client_id: CLIENT.installed.client_id } })).toThrow(/client_secret/);
    expect(() => c.importClient({ web: { ...CLIENT.installed, redirect_uris: ["http://localhost:8000/oauth2callback"] } })).toThrow(/http:\/\/localhost:4327\/oauth2callback/);
    expect(c.importClient({ web: { ...CLIENT.installed, redirect_uris: ["http://localhost:4327/oauth2callback"] } }).id).toBe(CLIENT.installed.client_id);
  });

  it("says the vault is locked rather than keeping it anywhere else", () => {
    const c = new GoogleConnection({ secrets: new SecretsRegistry(), places: googlePlaces({ KOS_GOOGLE_DIR: join(root, "google") }) });
    expect(() => c.importClient(CLIENT)).toThrow(/vault/);
    expect(c.status().vault).toMatch(/no vault/);
  });
});

describe("the Google server", () => {
  it("is not run until there is a client and a signed-in account", () => {
    const c = connection();
    expect(c.server()).toBeUndefined();
    c.importClient(CLIENT);
    expect(c.server()).toBeUndefined();
    signInAs(c, "me@example.com", scopesFor({ on: true, changes: false, send: false }));
    expect(c.server()).toBeDefined();
  });

  it("starts read-only, pinned, with its secrets in its env and its tokens under KOS's own folder", () => {
    const c = connection();
    c.importClient(CLIENT);
    signInAs(c, "me@example.com", []);
    const server = c.server()!;
    const pinned = ["--exclude-newer", RESOLVED_BEFORE, WORKSPACE_MCP, "--single-user", "--permissions", "gmail:readonly", "calendar:readonly", "drive:readonly", "docs:readonly", "--disabled-tools", "start_google_auth"];
    expect(server.args!.slice(-pinned.length)).toEqual(pinned);
    expect(server.env).toMatchObject({
      GOOGLE_OAUTH_CLIENT_ID: CLIENT.installed.client_id,
      GOOGLE_OAUTH_CLIENT_SECRET: CLIENT.installed.client_secret,
      WORKSPACE_MCP_CREDENTIALS_DIR: join(root, "google", "credentials"),
      HOME: join(root, "google", "home"),
      USER_GOOGLE_EMAIL: "me@example.com",
      WORKSPACE_MCP_DISABLE_LOCAL_FILES: "true",
      WORKSPACE_MCP_LOG_DIR: join(root, "google", "logs"),
      WORKSPACE_ATTACHMENT_DIR: join(root, "google", "attachments"),
      WORKSPACE_MCP_MAX_FILE_BYTES: String(25 * 1024 * 1024),
      TMPDIR: join(root, "google", "tmp"),
      BROWSER: "true",
    });
    expect(server.cwd).toBe(join(root, "google", "home"));
    expect(server.untrusted).toBe(true);
    expect(server.risks?.("send_gmail_message").asksAlways).toBe(true);
    for (const dir of ["google", "google/credentials", "google/home"]) expect(statSync(join(root, dir)).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "google", "credentials", "me@example.com.json")).mode & 0o777).toBe(0o600);
  });

  it("allows changes, and sending only past that, by the scopes the server is started with", async () => {
    // Changes leave Gmail read-only: gmail.compose and gmail.modify both let mail be sent.
    expect(permissionArgs({ on: true, changes: true, send: false })).toEqual(["--permissions", "gmail:readonly", "calendar:full", "drive:full", "docs:full"]);
    expect(scopesFor({ on: true, changes: true, send: false }).filter((s) => s.includes("gmail"))).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(permissionArgs({ on: true, changes: true, send: true })[1]).toBe("gmail:send");
    const c = connection();
    // Sending without changes is not a mode.
    expect(await c.setSettings({ send: true })).toEqual({ on: true, changes: false, send: false });
    let reloads = 0;
    c.onChange(() => void reloads++);
    expect(await c.setSettings({ changes: true, send: true })).toEqual({ on: true, changes: true, send: true });
    expect(reloads).toBe(1);
    expect(await c.setSettings({ on: false })).toMatchObject({ on: false });
    // Kept in KOS's Google folder, 0600, where no sql statement reaches.
    expect(readSettingsFile(c.places)).toMatchObject({ on: false, changes: true, send: true });
    expect(statSync(c.places.settings).mode & 0o777).toBe(0o600);
    c.importClient(CLIENT);
    signInAs(c, "me@example.com", []);
    expect(c.server()).toBeUndefined();
  });

  it("says which scopes a mode needs that the sign-in lacks", () => {
    const read = scopesFor({ on: true, changes: false, send: false });
    expect(missingScopes(read, read)).toEqual([]);
    const send = scopesFor({ on: true, changes: true, send: true });
    expect(missingScopes(send, read)).toContain("https://www.googleapis.com/auth/gmail.send");
    // gmail.modify covers the narrower Gmail scopes, drive covers drive.readonly.
    expect(missingScopes(read, ["gmail.modify", "calendar", "drive", "documents"].map((s) => `https://www.googleapis.com/auth/${s}`))).toEqual([]);
  });

  it("uses only the owner's own account, deleting any other sign-in before it starts", async () => {
    const c = connection();
    c.importClient(CLIENT);
    signInAs(c, "me@example.com", []);
    signInAs(c, "stranger@example.com", [], false);
    expect(c.server()!.env!["USER_GOOGLE_EMAIL"]).toBe("me@example.com");
    await until(() => !existsSync(join(c.places.credentials, "stranger@example.com.json")));
    expect(existsSync(join(c.places.credentials, "stranger@example.com.json"))).toBe(false);
    expect(c.account()?.email).toBe("me@example.com");
  });

  it.runIf(process.platform === "darwin")("runs in the jail: network open, KOS's ports shut but the callback's, KOS's other secrets unreadable", () => {
    const places = googlePlaces({ KOS_GOOGLE_DIR: join(root, "google") });
    const { command, args } = jailed(places, 4327, ["x"]);
    if (command === "uvx") return; // no uvx on this machine: nothing to jail
    expect(command).toBe("/usr/bin/sandbox-exec");
    const profile = args[1]!;
    expect(profile).not.toContain("(deny network*)");
    expect(profile).toContain('(deny network-outbound (remote ip "*:4317"))');
    expect(profile).not.toContain('"*:4327"');
    expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(join(root, "google"))})`);
    const denied = profile.split("\n").filter((l) => l.startsWith("(deny file-read*"));
    expect(denied.some((l) => l.includes(`${join(root, "google")}"`))).toBe(false);
  });

  it("turns the server's own request to sign in into words for the owner, with no link to follow", () => {
    expect(presentResult(URL_SAID.replace("**ACTION REQUIRED**", "**ACTION REQUIRED: Google Authentication Needed for Google Calendar**"))).toBe(SIGN_IN_AGAIN);
    expect(presentResult("Error calling tool 'get_events': **ACTION REQUIRED: Google Authentication Needed for x")).toBe(SIGN_IN_AGAIN);
    // A mail that quotes the prompt is the mail, not a request.
    expect(presentResult(`Subject: hi\n${URL_SAID}`)).toBe(`Subject: hi\n${URL_SAID}`);
    expect(presentResult("3 events today")).toBe("3 events today");
  });
});

describe("signing in", () => {
  it("takes the tool server down, hands back Google's address, and brings it up once the token is written", async () => {
    const opened: string[][] = [];
    const hinted: string[] = [];
    let closed = 0;
    const c = connection({
      authSession: async (config, email) => {
        opened.push(config.args ?? []);
        hinted.push(email);
        return { start: async () => URL_SAID, close: async () => void closed++ } satisfies AuthSession;
      },
    });
    c.importClient(CLIENT);
    const seen: boolean[] = [];
    c.onChange(() => void seen.push(c.status().signingIn));
    await expect(c.signIn()).rejects.toThrow(/say which Google address/);
    await expect(c.signIn("not an address")).rejects.toThrow(/not an email address/);
    const { url } = await c.signIn("Me@Example.com");
    expect(hinted).toEqual(["me@example.com"]);
    expect(c.status().email).toBe("me@example.com");
    expect(url).toBe("https://accounts.google.com/o/oauth2/auth?client_id=123&state=s");
    // The sign-in server offers start_google_auth; the tool server never does.
    expect(opened[0]).not.toContain("--disabled-tools");
    expect(c.status().signingIn).toBe(true);
    expect(c.server()).toBeUndefined();
    await expect(c.signIn()).rejects.toThrow(/already waiting/);
    signInAs(c, "me@example.com", scopesFor(c.settings()));
    await until(() => !c.status().signingIn);
    expect(closed).toBe(1);
    expect(seen).toEqual([true, false]);
    expect(c.status().account?.email).toBe("me@example.com");
    expect(c.server()).toBeDefined();
    // Signed in as one address, another needs a disconnect first; the same one signs in again without saying it.
    await expect(c.signIn("other@example.com")).rejects.toThrow(/disconnect first/);
  });

  it("refuses a sign-in as any other account: revoked and deleted, and the sign-in fails saying so", async () => {
    const revoked: string[] = [];
    const c = connection({
      fetch: async (_url, init) => (revoked.push(init.body), { ok: true, status: 200 }),
      authSession: async () => ({ start: async () => URL_SAID, close: async () => undefined }),
    });
    c.importClient(CLIENT);
    await c.signIn("me@example.com");
    signInAs(c, "stranger@example.com", scopesFor(c.settings()), false);
    await until(() => !c.status().signingIn);
    expect(c.status().error).toMatch(/signed in as stranger@example.com, not me@example.com/);
    expect(revoked).toHaveLength(1);
    expect(existsSync(join(c.places.credentials, "stranger@example.com.json"))).toBe(false);
    expect(c.account()).toBeUndefined();
    expect(c.server()).toBeUndefined();
  });

  it("gives up after the wait, saying so", async () => {
    const c = connection({ waitMs: 20, authSession: async () => ({ start: async () => URL_SAID, close: async () => undefined }) });
    c.importClient(CLIENT);
    await c.signIn("me@example.com");
    await until(() => !c.status().signingIn);
    expect(c.status().error).toMatch(/not finished/);
  });

  it("refuses without a client, and reports a server that gives no address", async () => {
    const c = connection({ authSession: async () => ({ start: async () => "**Authentication Error:** nope", close: async () => undefined }) });
    await expect(c.signIn("me@example.com")).rejects.toThrow(/import the Google OAuth client first/);
    c.importClient(CLIENT);
    await expect(c.signIn("me@example.com")).rejects.toThrow(/no sign-in address: \*\*Authentication Error/);
    expect(c.status().signingIn).toBe(false);
  });
});

describe("disconnecting", () => {
  it("revokes the refresh token at Google and deletes every token file", async () => {
    const posted: string[] = [];
    const c = connection({ fetch: async (url, init) => (posted.push(`${url} ${init.body}`), { ok: true, status: 200 }) });
    c.importClient(CLIENT);
    signInAs(c, "me@example.com", []);
    writeFileSync(join(c.places.credentials, "oauth_states.json"), "{}");
    mkdirSync(c.places.logs, { recursive: true });
    writeFileSync(join(c.places.logs, "mcp_server_debug.log"), "subject lines");
    mkdirSync(c.places.attachments, { recursive: true });
    writeFileSync(join(c.places.attachments, "a.pdf"), "x");
    expect(await c.disconnect()).toEqual({ accounts: ["me@example.com"], revoked: true });
    expect(posted).toEqual(["https://oauth2.googleapis.com/revoke token=1%2F%2Fr"]);
    expect(c.account()).toBeUndefined();
    expect(existsSync(join(c.places.credentials, "oauth_states.json"))).toBe(false);
    expect(existsSync(join(c.places.logs, "mcp_server_debug.log"))).toBe(false);
    expect(existsSync(join(c.places.attachments, "a.pdf"))).toBe(false);
    expect(c.status().email).toBeNull();
    expect(statSync(c.places.credentials).mode & 0o777).toBe(0o700);
    // The client stays for the next sign-in.
    expect(c.status().client?.id).toBe(CLIENT.installed.client_id);
  });

  it("deletes the tokens even when Google cannot be reached, and says it did not confirm", async () => {
    const c = connection({ fetch: async () => { throw new Error("offline"); } });
    signInAs(c, "me@example.com", []);
    expect((await c.disconnect()).revoked).toBe(false);
    expect(c.account()).toBeUndefined();
  });
});
