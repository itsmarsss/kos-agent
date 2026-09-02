import { injectSecrets, injectSecretsInString } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { KosModule } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

export type FetchImpl = typeof fetch;

export interface HttpModuleOptions {
  /** Hostnames the agent may fetch. Empty means deny all (allowlist-only). */
  allowedHosts?: string[];
  timeoutMs?: number;
  /** Response body cap in bytes. */
  maxBytes?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_000_000;

function hostAllowed(url: string, allowed: Set<string>): boolean {
  try {
    return allowed.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function doFetch(
  input: Record<string, unknown>,
  opts: Required<Omit<HttpModuleOptions, "allowedHosts">> & { allowed: Set<string> },
  secrets: SecretsRegistry,
): Promise<string> {
  const rawUrl = input.url;
  if (typeof rawUrl !== "string") throw new Error("http.fetch requires a url");
  // Inject secrets after reasoning, just before the request leaves.
  const url = injectSecretsInString(rawUrl, secrets);
  if (!hostAllowed(url, opts.allowed)) {
    throw new Error(`host not allowlisted: ${new URL(url).hostname}`);
  }

  const headers = injectSecrets(
    (input.headers as Record<string, string>) ?? {},
    secrets,
  );
  const method = typeof input.method === "string" ? input.method : "GET";
  const body =
    typeof input.body === "string"
      ? injectSecretsInString(input.body, secrets)
      : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const capped = text.slice(0, opts.maxBytes);
    return JSON.stringify({
      status: res.status,
      truncated: text.length > opts.maxBytes,
      body: capped,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `http.fetch` tool module: fetch a URL with a domain allowlist, timeout,
 * and size cap. Secrets are referenced by name in args ({{secret:name}}) and
 * injected by the harness at call time, so the model never sees the real value.
 * Risky tier: queues for approval; a non-allowlisted host is rejected outright.
 */
export function createHttpModule(options: HttpModuleOptions = {}): KosModule {
  const allowed = new Set(
    (options.allowedHosts ?? []).map((h) => h.toLowerCase()),
  );
  const resolved = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    fetchImpl: options.fetchImpl ?? fetch,
    allowed,
  };

  return {
    manifest: {
      name: "http",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "http.fetch", version: "1.0.0" }],
      riskTier: "risky",
    },
    activate(ctx) {
      const { secrets } = requireServices(ctx);
      ctx.registerTool(
        {
          name: "http.fetch",
          description:
            "Fetch a URL (allowlisted hosts only). Reference secrets by name as {{secret:name}} in url/headers/body; the harness injects real values.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              method: { type: "string" },
              headers: { type: "object" },
              body: { type: "string" },
            },
            required: ["url"],
          },
        },
        (input) => doFetch(input, resolved, secrets),
        {
          /*
           * The allow-list is the permission.
           *
           * Every fetch used to queue for approval, including to a host the
           * owner had explicitly listed -- so the answer to "may it reach
           * rss.nytimes.com" was given twice, once in settings and again on
           * every call. A host that is not on the list is refused by the
           * tool regardless, so asking about that one is theatre too.
           *
           * What still asks is a write. Reading a page the owner allowed is
           * what the list is for; posting to it is a different act, and one
           * that can carry data out of the workspace.
           */
          floor: "safe",
          escalate: (input) => {
            const method = String(input["method"] ?? "GET").toUpperCase();
            return method !== "GET" && method !== "HEAD";
          },
        },
      );
    },
  };
}
