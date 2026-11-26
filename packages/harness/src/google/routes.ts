import type { ApiResponse } from "../kernel/server.js";
import type { Kernel } from "../kernel/kernel.js";
import { GOOGLE_SERVER, type GoogleSettings, type GoogleStatus } from "./connection.js";

/**
 * Settings > Connections > Google, and `kos google`, as routes. They sit
 * behind the dashboard's token, write key and cross-site check as every
 * route does. No answer holds the client secret or a token: the client is
 * named by its id, the account by its email and the scopes it granted.
 */

export const GOOGLE_PREFIX = "/api/google";

/** The connection as the page shows it, with whether its server is up and how many tools it serves. */
export interface GoogleView extends GoogleStatus {
  server: { connected: boolean; tools: number; error?: string } | null;
}

export function googleView(kernel: Kernel): GoogleView {
  const live = kernel.mcp.status()[GOOGLE_SERVER];
  return { ...kernel.google.status(), server: live ? { connected: live.connected, tools: live.tools.length, ...(live.error ? { error: live.error } : {}) } : null };
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body, headers: { "cache-control": "no-store" } });
const fail = (status: number, err: unknown): ApiResponse => ({ status, body: { error: err instanceof Error ? err.message : String(err) }, headers: { "cache-control": "no-store" } });

function settingsPatch(body: Record<string, unknown>): Partial<GoogleSettings> {
  const patch: Partial<GoogleSettings> = {};
  for (const key of ["on", "changes", "send"] as const) if (typeof body[key] === "boolean") patch[key] = body[key];
  return patch;
}

export async function googleRoute(kernel: Kernel, method: string, path: string, body: Record<string, unknown>): Promise<ApiResponse | undefined> {
  if (!path.startsWith(GOOGLE_PREFIX)) return undefined;
  const audit = (tool: string, args: Record<string, unknown>, result: string, isError = false): void =>
    void kernel.audit.record({ tool: `google.${tool}`, args, result, isError, userId: kernel.profile.ownerId });

  if (method === "GET" && path === GOOGLE_PREFIX) return ok(googleView(kernel));

  /** The JSON downloaded from Google Cloud, as text or parsed. */
  if (method === "POST" && path === `${GOOGLE_PREFIX}/client`) {
    let raw: unknown = body.client;
    if (typeof body.json === "string") {
      try {
        raw = JSON.parse(body.json);
      } catch {
        return fail(400, "that is not JSON: paste the whole file Google Cloud downloaded");
      }
    }
    try {
      const { id } = kernel.google.importClient(raw);
      audit("client", { id }, "kept in the vault");
      return ok(googleView(kernel));
    } catch (err) {
      return fail(400, err);
    }
  }

  if (method === "POST" && path === `${GOOGLE_PREFIX}/signin`) {
    try {
      const { url } = await kernel.google.signIn(typeof body.email === "string" ? body.email : undefined);
      audit("signin", {}, "waiting for the browser");
      return ok({ url, ...googleView(kernel) });
    } catch (err) {
      return fail(400, err);
    }
  }

  if (method === "POST" && path === `${GOOGLE_PREFIX}/settings`) {
    const patch = settingsPatch(body);
    if (Object.keys(patch).length === 0) return fail(400, "nothing to change: on, changes or send");
    const settings = await kernel.google.setSettings(patch);
    audit("settings", { ...settings }, "saved");
    return ok(googleView(kernel));
  }

  if (method === "POST" && path === `${GOOGLE_PREFIX}/disconnect`) {
    const done = await kernel.google.disconnect();
    audit("disconnect", { accounts: done.accounts }, done.revoked ? "revoked and deleted" : "deleted; Google did not confirm the revoke");
    return ok({ ...done, ...googleView(kernel) });
  }

  return undefined;
}
