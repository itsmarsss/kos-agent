import { Agent, fetch as undiciFetch } from "undici";

import { officeKindOf, officeNote, officeText } from "../files/office.js";
import { pdfText } from "../files/pdftext.js";
import { injectSecrets, injectSecretsInString } from "../secrets/inject.js";
import type { SecretsRegistry } from "../secrets/secrets.js";
import type { KosModule } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { guardedLookup, refusedUrl } from "./egress.js";

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
  /** Injectable for tests; defaults to a fetch whose connections refuse this machine and its local network. */
  fetchImpl?: FetchImpl;
  /** KOS's own hosts as they are reached (host, or host:port): never fetched, whatever they resolve to. */
  ownHosts?: () => string[];
}

/** Redirects followed, each checked as the first request was. */
const MAX_REDIRECTS = 5;

/**
 * The platform's fetch, held to the public internet: every connection's
 * address is checked as it is made, so a name that resolves to this machine
 * or its network (KOS's own API on loopback above all) is refused, however
 * it got there.
 */
const publicAgent = new Agent({ connect: { lookup: guardedLookup } });
const publicFetch: FetchImpl = (input, init) => undiciFetch(input as string, { ...(init as object), dispatcher: publicAgent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_000_000;

async function pdfBody(res: Response): Promise<string> {
  const read = await pdfText(new Uint8Array(await res.arrayBuffer()));
  return `[PDF, ${read.pages} page${read.pages === 1 ? "" : "s"}${read.truncated ? ", cut at the cap" : ""}]\n${read.text}`;
}

/** The body as words: a PDF or an Office document read, anything else as it came. */
async function bodyText(res: Response): Promise<string> {
  const type = res.headers.get("content-type") ?? "";
  if (/^application\/pdf\b/i.test(type)) return pdfBody(res);
  const name = (() => {
    try {
      return new URL(res.url).pathname;
    } catch {
      return "";
    }
  })();
  if (officeKindOf(type, name)) {
    const read = officeText(new Uint8Array(await res.arrayBuffer()), name, type);
    return `[${officeNote(read)}]\n${read.text}`;
  }
  return res.text();
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

async function doFetch(
  input: Record<string, unknown>,
  opts: Required<Omit<HttpModuleOptions, "allowedHosts" | "ownHosts">> & { own: () => string[] },
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
    // Followed by hand, so each hop is checked: a public page that redirects to loopback reaches nothing.
    let at = url;
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const refused = refusedUrl(at, opts.own());
      if (refused) throw new Error(refused);
      res = await opts.fetchImpl(at, { method: hop === 0 ? method : "GET", headers, ...(hop === 0 && body !== undefined ? { body } : {}), redirect: "manual", signal: controller.signal });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) break;
      if (hop === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${rawUrl}`);
      at = new URL(next, at).toString();
    }
    if (!res) throw new Error(`no answer from ${rawUrl}`);
    // A PDF comes back as its words, not its bytes: a paper or a bill at a
    // url is as ordinary a thing to read as a page.
    const text = await bodyText(res);
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
    fetchImpl: options.fetchImpl ?? publicFetch,
    own: options.ownHosts ?? (() => []),
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
          beyondAuto: (input) => (String(input["method"] ?? "GET").toUpperCase() === "DELETE" ? "deletes something outside the workspace" : false),
          escalate: (input) => {
            const method = String(input["method"] ?? "GET").toUpperCase();
            if (method !== "GET" && method !== "HEAD") return `a ${method} request, which can carry data out`;
            const host = typeof input["url"] === "string" ? hostOf(input["url"]) : undefined;
            if (host === undefined) return "no host to check against the allowed hosts";
            return allowed().has(host) ? false : `${host} is not on the allowed hosts`;
          },
        },
      );
    },
  };
}
