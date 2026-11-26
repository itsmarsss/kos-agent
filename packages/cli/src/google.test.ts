import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GoogleView } from "@kos/harness";

import { GOOGLE_USAGE, describe as describeView, runGoogle, type GoogleHost } from "./google.js";

const VIEW: GoogleView = {
  client: { id: "123.apps.googleusercontent.com" },
  account: { email: "me@example.com", scopes: ["https://www.googleapis.com/auth/gmail.readonly"], refreshable: true, savedAt: 1 },
  settings: { on: true, changes: false, send: false },
  missing: [],
  signingIn: false,
  redirectUri: "http://localhost:4327/oauth2callback",
  email: "me@example.com",
  server: { connected: true, tools: 24 },
};

/** A host that records each call and answers from a script. */
function host(answers: Record<string, unknown[]>): GoogleHost & { calls: string[] } {
  const calls: string[] = [];
  const answer = async <T>(key: string): Promise<T> => {
    const queue = answers[key] ?? [VIEW];
    return (queue.length > 1 ? queue.shift() : queue[0]) as T;
  };
  return {
    calls,
    get: <T>(path: string) => (calls.push(`GET ${path}`), answer<T>(`GET ${path}`)),
    post: <T>(path: string, body?: unknown) => (calls.push(`POST ${path} ${JSON.stringify(body ?? {})}`), answer<T>(`POST ${path}`)),
  };
}

function io() {
  const said: string[] = [];
  const opened: string[] = [];
  return { said, opened, say: (l: string) => void said.push(l), open: (u: string) => void opened.push(u), pollMs: 1, waitMs: 1000 };
}

describe("kos google", () => {
  it("shows the client by id, the account, its scopes, mode and server", async () => {
    const h = host({});
    const out = io();
    await runGoogle(h, [], out);
    expect(h.calls).toEqual(["GET /api/google"]);
    expect(out.said).toEqual(["client: 123.apps.googleusercontent.com", "account: me@example.com", "scopes: gmail.readonly", "mode: read only", "server: connected, 24 tools"]);
    expect(describeView({ ...VIEW, client: null, vault: "the vault is locked", account: null })).toContain("client: none (the vault is locked)");
  });

  it("imports the client JSON through the host and says to delete the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kos-google-cli-"));
    try {
      const file = join(dir, "client_secret.json");
      writeFileSync(file, '{"installed":{"client_id":"x"}}');
      const h = host({});
      const out = io();
      await runGoogle(h, ["import", file], out);
      expect(h.calls).toEqual([`POST /api/google/client ${JSON.stringify({ json: '{"installed":{"client_id":"x"}}' })}`]);
      expect(out.said.at(-1)).toContain(`delete ${file}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs in: opens Google's address, then waits until the host says it is done", async () => {
    const url = "https://accounts.google.com/o/oauth2/auth?x=1";
    const h = host({ "POST /api/google/signin": [{ ...VIEW, url, signingIn: true }], "GET /api/google": [{ ...VIEW, signingIn: true }, VIEW] });
    const out = io();
    await runGoogle(h, ["signin", "me@example.com"], out);
    expect(h.calls[0]).toBe('POST /api/google/signin {"email":"me@example.com"}');
    expect(out.opened).toEqual([url]);
    expect(out.said).toContain(url);
    expect(h.calls.filter((c) => c === "GET /api/google")).toHaveLength(2);
  });

  it("sets the mode: read, changes, or changes with sending", async () => {
    const h = host({});
    await runGoogle(h, ["mode", "changes"], io());
    await runGoogle(h, ["mode", "send"], io());
    await runGoogle(h, ["mode", "read"], io());
    await runGoogle(h, ["off"], io());
    expect(h.calls).toEqual([
      'POST /api/google/settings {"changes":true,"send":false}',
      'POST /api/google/settings {"changes":true,"send":true}',
      'POST /api/google/settings {"changes":false,"send":false}',
      'POST /api/google/settings {"on":false}',
    ]);
    await expect(runGoogle(h, ["mode", "everything"], io())).rejects.toThrow(GOOGLE_USAGE);
  });

  it("disconnects, saying whether Google confirmed the revoke", async () => {
    const out = io();
    await runGoogle(host({ "POST /api/google/disconnect": [{ ...VIEW, account: null, accounts: ["me@example.com"], revoked: false }] }), ["disconnect"], out);
    expect(out.said[0]).toMatch(/did not confirm the revoke: me@example.com/);
  });

  it("refuses what it does not know", async () => {
    await expect(runGoogle(host({}), ["frobnicate"], io())).rejects.toThrow(GOOGLE_USAGE);
    await expect(runGoogle(host({}), ["import"], io())).rejects.toThrow(GOOGLE_USAGE);
  });
});
