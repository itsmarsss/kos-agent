import { readFileSync } from "node:fs";

import { GOOGLE_PREFIX, type GoogleView } from "@kos/harness";

/**
 * `kos google ...`: the owner's Google account from a terminal, through the
 * running host, which holds the vault. The same steps as Settings >
 * Connections: import the client JSON, sign in in the browser, choose how
 * far KOS may go, disconnect.
 */

export const GOOGLE_USAGE = "usage: kos google [status] | import <client_secret.json> | signin | mode read|changes|send | on | off | disconnect";

/** What the command needs of the host: the KosClient's two calls. */
export interface GoogleHost {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface GoogleIo {
  say(line: string): void;
  /** Opens the sign-in address in the owner's browser; a test records it. */
  open(url: string): void;
  /** How long to wait between looks while a sign-in waits, and in all. */
  pollMs?: number;
  waitMs?: number;
}

const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/** The connection in a few lines: client, account, mode, server. */
export function describe(view: GoogleView): string[] {
  const lines = [`client: ${view.client ? view.client.id : `none${view.vault ? ` (${view.vault})` : ""}`}`];
  if (!view.account) lines.push("account: not signed in");
  else {
    lines.push(`account: ${view.account.email}`);
    lines.push(`scopes: ${view.account.scopes.map((s) => s.replace(SCOPE_PREFIX, "")).join(" ")}`);
  }
  const mode = !view.settings.changes ? "read only" : view.settings.send ? "changes and sending mail" : "changes, no sending";
  lines.push(`mode: ${view.settings.on ? mode : "off"}`);
  if (view.missing.length) lines.push(`sign in again to grant: ${view.missing.map((s) => s.replace(SCOPE_PREFIX, "")).join(" ")}`);
  if (view.signingIn) lines.push("signing in: waiting for the browser");
  if (view.error) lines.push(`last sign-in: ${view.error}`);
  if (view.server) lines.push(`server: ${view.server.connected ? `connected, ${view.server.tools} tools` : `not connected${view.server.error ? ` (${view.server.error})` : ""}`}`);
  return lines;
}

const MODES: Record<string, { changes: boolean; send: boolean }> = {
  read: { changes: false, send: false },
  changes: { changes: true, send: false },
  send: { changes: true, send: true },
};

export async function runGoogle(host: GoogleHost, rest: string[], io: GoogleIo): Promise<void> {
  const [sub = "status", arg] = rest;
  const show = (view: GoogleView): void => describe(view).forEach((l) => io.say(l));

  if (sub === "status") return show(await host.get<GoogleView>(GOOGLE_PREFIX));

  if (sub === "import") {
    if (!arg) throw new Error(GOOGLE_USAGE);
    const view = await host.post<GoogleView>(`${GOOGLE_PREFIX}/client`, { json: readFileSync(arg, "utf8") });
    show(view);
    io.say(`kept in the vault; delete ${arg} now, KOS no longer needs it`);
    return;
  }

  if (sub === "signin") {
    const { url } = await host.post<GoogleView & { url: string }>(`${GOOGLE_PREFIX}/signin`);
    io.say("sign in in your browser; if it did not open, go to:");
    io.say(url);
    io.open(url);
    const until = Date.now() + (io.waitMs ?? 10 * 60_000);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, io.pollMs ?? 2000));
      const view = await host.get<GoogleView>(GOOGLE_PREFIX);
      if (!view.signingIn || Date.now() >= until) return show(view);
    }
  }

  if (sub === "mode") {
    const mode = MODES[arg ?? ""];
    if (!mode) throw new Error(GOOGLE_USAGE);
    return show(await host.post<GoogleView>(`${GOOGLE_PREFIX}/settings`, mode));
  }

  if (sub === "on" || sub === "off") return show(await host.post<GoogleView>(`${GOOGLE_PREFIX}/settings`, { on: sub === "on" }));

  if (sub === "disconnect") {
    const done = await host.post<GoogleView & { revoked: boolean; accounts: string[] }>(`${GOOGLE_PREFIX}/disconnect`);
    io.say(done.accounts.length === 0 ? "nothing was signed in" : done.revoked ? `revoked at Google and deleted: ${done.accounts.join(", ")}` : `deleted, but Google did not confirm the revoke: ${done.accounts.join(", ")}; remove KOS at myaccount.google.com/permissions`);
    return show(done);
  }

  throw new Error(GOOGLE_USAGE);
}
