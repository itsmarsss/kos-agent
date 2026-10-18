import { injectSecrets, injectSecretsInString } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { KosModule } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

export type FetchImpl = typeof fetch;

export interface HttpModuleOptions {
  /** Hostnames the agent may fetch. Empty means deny all (allowlist-only). */
  /**
   * Hosts the agent may reach. A function is read at call time, which is what
   * lets the owner add one in Settings and have the next message use it:
   * captured once at boot, a host added at noon did nothing until the daemon
   * was restarted.
   */
  allowedHosts?: string[] | (() => string[]);
  timeoutMs?: number;
  /** Response body cap in bytes. */
  maxBytes?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_000_000;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

async function doFetch(
  input: Record<string, unknown>,
  opts: Required<Omit<HttpModuleOptions, "allowedHosts">>,
  secrets: SecretsRegistry,
): Promise<string> {
  const rawUrl = input.url;
  if (typeof rawUrl !== "string") throw new Error("http.fetch requires a url");
  // Inject secrets after reasoning, just before the request leaves.
  const url = injectSecretsInString(rawUrl, secrets);
  // The list decides what asks, not what runs: a host not on it reached
  // this handler only because the owner said yes to that call.
  if (!hostOf(url)) throw new Error(`not a url: ${rawUrl}`);

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
 * The `http.fetch` tool module: fetch a URL, with a timeout and a size cap.
 * Secrets are referenced by name in args ({{secret:name}}) and injected by
 * the harness at call time, so the model never sees the real value. The
 * owner's host list says which reads run unasked; any other host asks, and
 * a yes the owner remembers is kept per host (see ops/permissions scopeOf).
 */
export function createHttpModule(options: HttpModuleOptions = {}): KosModule {
  const allowed = (): Set<string> => {
    const list =
      typeof options.allowedHosts === "function"
        ? options.allowedHosts()
        : (options.allowedHosts ?? []);
    return new Set(list.map((h) => h.trim().toLowerCase()).filter(Boolean));
  };
  const resolved = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    fetchImpl: options.fetchImpl ?? fetch,
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
            "Fetch a URL. A read from a host on the owner's list runs at once; any other host, and any write, asks the owner first, and a yes they remember stands for that host. " +
            "Reference secrets by name as {{secret:name}} in url/headers/body; the harness injects real values.",
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
           * The list is what runs unasked; everything else asks.
           *
           * Every fetch used to queue for approval, including to a host the
           * owner had explicitly listed, so "may it reach rss.nytimes.com"
           * was answered twice. Then a host off the list was refused outright,
           * which left a watcher that only needed one feed flailing in the
           * browser instead, while browser.visit would have opened the same
           * site unasked. Now a read from a listed host runs at once, a read
           * from any other host asks (and "always" keeps that host, since a
           * remembered fetch is scoped to its host), and a write asks
           * whatever the host: posting can carry data out of the workspace.
           */
          floor: "safe",
          escalate: (input) => {
            const method = String(input["method"] ?? "GET").toUpperCase();
            if (method !== "GET" && method !== "HEAD") return true;
            const host = typeof input["url"] === "string" ? hostOf(input["url"]) : undefined;
            return host === undefined || !allowed().has(host);
          },
        },
      );
    },
  };
}
