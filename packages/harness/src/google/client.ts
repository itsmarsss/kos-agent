import type { SecretsRegistry } from "../secrets/secrets.js";
import type { Vault } from "../secrets/vault.js";

/**
 * The owner's Google OAuth client: the JSON Google Cloud hands out for it,
 * read once and kept in the vault as an API key KOS runs on (`use.harness`
 * google): the secret as its token, the id as its username. Never written to
 * mcp.json or any other file; the server is given both in its environment
 * when it starts.
 */

export const GOOGLE_HARNESS = "google";
export const CLIENT_LABEL = "Google OAuth client";

export interface GoogleClient {
  id: string;
  secret: string;
}

const ID_SHAPE = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;

/**
 * The client from the downloaded JSON: a Desktop app's (`installed`), a Web
 * app's (`web`, which must list KOS's redirect address), or the two fields
 * on their own. A throw says what is wrong, in words the owner can act on.
 */
export function parseClientJson(raw: unknown, redirectUri: string): GoogleClient {
  if (typeof raw !== "object" || raw === null) throw new Error("that is not a Google OAuth client file: it is not a JSON object");
  const shaped = raw as { installed?: unknown; web?: unknown };
  const inner = (shaped.installed ?? shaped.web ?? raw) as { client_id?: unknown; client_secret?: unknown; redirect_uris?: unknown };
  const id = typeof inner.client_id === "string" ? inner.client_id.trim() : "";
  const secret = typeof inner.client_secret === "string" ? inner.client_secret.trim() : "";
  if (!ID_SHAPE.test(id)) throw new Error("that is not a Google OAuth client file: it has no client_id ending in .apps.googleusercontent.com");
  if (!secret) throw new Error("that client file has no client_secret; download the JSON again from Google Cloud > Clients");
  if (shaped.web !== undefined) {
    const uris = Array.isArray(inner.redirect_uris) ? inner.redirect_uris : [];
    if (!uris.includes(redirectUri)) {
      throw new Error(`this is a Web application client without ${redirectUri} as an authorized redirect URI; add it in Google Cloud, or make a Desktop app client instead`);
    }
  }
  return { id, secret };
}

/** The vault, when it is open: the client is only ever read from or written to an open one. */
function openVault(secrets: SecretsRegistry): Vault | undefined {
  const vault = secrets.attached();
  return vault?.status().state === "ready" ? vault : undefined;
}

/** Why the client cannot be read or kept now, or undefined when the vault is open. */
export function vaultProblem(secrets: SecretsRegistry): string | undefined {
  const state = secrets.attached()?.status().state;
  if (state === "ready") return undefined;
  if (state === "locked") return "the vault is locked; open it under Settings > Permissions > Secrets";
  return "there is no vault yet; make one under Settings > Permissions > Secrets";
}

/** Keep the client in the vault, replacing the one kept before. Returns its handle. */
export function storeClient(secrets: SecretsRegistry, client: GoogleClient): string {
  const vault = openVault(secrets);
  if (!vault) throw new Error(`cannot keep the Google client: ${vaultProblem(secrets)}`);
  const values = { token: client.secret, username: client.id };
  const kept = vault.harness(GOOGLE_HARNESS);
  if (kept) return vault.update(kept.handle, { values }).handle;
  return vault.add({ label: CLIENT_LABEL, kind: "apikey", values, use: { harness: GOOGLE_HARNESS } });
}

/** The client from the vault, while it is open and holds one. */
export function readClient(secrets: SecretsRegistry): GoogleClient | undefined {
  const vault = openVault(secrets);
  const meta = vault?.harness(GOOGLE_HARNESS);
  if (!vault || !meta) return undefined;
  const secret = vault.value(meta.handle, "token");
  const id = vault.value(meta.handle, "username");
  return secret && id ? { id, secret } : undefined;
}
