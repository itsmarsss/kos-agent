import { Agent, fetch as undiciFetch } from "undici";

import { officeKindOf, officeNote, officeText } from "../files/office.js";
import { pdfText } from "../files/pdftext.js";
import { hostAllowed, type SecretSlots } from "../secrets/inject.js";
import type { KosModule } from "../modules/loader.js";
import { kosPorts } from "../sandbox/jail.js";
import { lookupFor, parseLanAllow, refusedUrl, type LanAllow } from "./egress.js";

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
  /**
   * Reach this machine after all, through the platform's own fetch: for a
   * test that serves its redirects on loopback. Boot never sets it.
   */
  local?: boolean;
  /** The owner's list of places on their network http.fetch may reach (KOS_FETCH_LAN), read at each call. */
  lan?: () => string | undefined;
}

/** The own-hosts list a local test passes, by identity: nothing is refused for being local. */
const LOCAL: readonly string[] = [];

/**
 * The platform's fetch, held to the public internet: every connection's
 * address is checked as it is made, so a name that resolves to this machine
 * or its network (KOS's own API on loopback above all) is refused, however
 * it got there.
 */
function publicFetch(allow: () => LanAllow): FetchImpl {
  return async (input, init) => {
    const url = new URL(String(input));
    // An agent per request, its lookup told the port: the owner's list names places by address and port together.
    const dispatcher = new Agent({ connect: { lookup: lookupFor(Number(url.port || (url.protocol === "https:" ? 443 : 80)), allow()) } });
    try {
      const res = (await undiciFetch(url.href, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
      // The body is read after this returns; the agent closes once it is done with it.
      void dispatcher.close();
      return res;
    } catch (err) {
      void dispatcher.destroy();
      throw err;
    }
  };
}

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

/**
 * Where a secret may go: a header, or the URL's query string, never its host
 * or path, so the host the call is judged and bound by is the one it reaches.
 * Not the body: a write already asks, and a body is free text the model
 * shapes, the easiest place to send a key somewhere it was not meant for.
 * And only to a host the secret is bound to: one bound nowhere is sent nowhere.
 */
export const HTTP_SECRET_SLOTS: SecretSlots = {
  paths: ["headers.*", "url"],
  urls: ["url"],
  host: (input) => (typeof input["url"] === "string" ? hostOf(input["url"]) : undefined),
  admit: (name, input, secrets) => {
    const bound = secrets.hostsOf(name);
    if (!bound) return `Secret ${name} is bound to no host, so http.fetch does not send it. The owner binds it with KOS_SECRET_${name.toUpperCase()}_HOSTS.`;
    const host = typeof input["url"] === "string" ? hostOf(input["url"]) : undefined;
    return host && hostAllowed(host, bound) ? undefined : `Secret ${name} may be sent only to ${bound.join(", ")}, not ${host ?? "an unknown host"}.`;
  },
};

/** The call as it reaches here has its secrets in place: GuardedTools expands them in the slots above. */
async function doFetch(
  input: Record<string, unknown>,
  opts: Required<Omit<HttpModuleOptions, "allowedHosts" | "ownHosts" | "local" | "lan">> & { own: () => readonly string[]; allow: () => LanAllow },
): Promise<string> {
  const url = input.url;
  if (typeof url !== "string") throw new Error("http.fetch requires a url");
  // The list decides what asks, not what runs: a host not on it reached
  // this handler only because the owner said yes to that call.
  if (!hostOf(url)) throw new Error("not a url");

  const headers = (input.headers as Record<string, string>) ?? {};
  const method = typeof input.method === "string" ? input.method : "GET";
  const body = typeof input.body === "string" ? input.body : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const followed = await follow(url, { method, headers, body, signal: controller.signal }, opts.fetchImpl, opts.own(), opts.allow());
    if ("elsewhere" in followed) {
      return JSON.stringify({
        status: followed.status,
        redirect: followed.elsewhere,
        note: "The server sent this to another site. Nothing was fetched there; call http.fetch with that url to follow it.",
      });
    }
    // A PDF comes back as its words, not its bytes: a paper or a bill at a
    // url is as ordinary a thing to read as a page.
    const text = await bodyText(followed);
    const capped = text.slice(0, opts.maxBytes);
    return JSON.stringify({
      status: followed.status,
      truncated: text.length > opts.maxBytes,
      body: capped,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Redirects followed within one origin before the chain is called a loop. */
const REDIRECTS_MAX = 5;

/** The statuses that redirect; a 300 or 304 with a Location is an answer, not a hop. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The request a redirect leads to, as browsers make it: a POST after a 301 or
 * 302, and anything but HEAD after a 303, becomes a GET with no body, and
 * the headers that described the body go with it.
 */
function afterRedirect(status: number, request: RequestInit): RequestInit {
  const method = (request.method ?? "GET").toUpperCase();
  const asRead = ((status === 301 || status === 302) && method === "POST") || (status === 303 && method !== "HEAD");
  if (!asRead) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  return { ...request, method: "GET", body: null, headers };
}

/**
 * The request, its redirects followed only within its own origin.
 *
 * A redirect to another site is not followed: it would carry the call's
 * headers, secrets among them, to a host nobody judged or bound them to.
 * Where it pointed is handed back instead, so following it is a call of its
 * own, judged and checked against the secret's hosts like any other.
 */
async function follow(url: string, init: RequestInit, fetchImpl: FetchImpl, own: readonly string[], allow: LanAllow): Promise<Response | { status: number; elsewhere: string }> {
  let at = new URL(url);
  let request = init;
  for (let hop = 0; ; hop++) {
    // Each hop checked before it is asked: this machine, its network and KOS itself are never reached.
    const refused = own === LOCAL ? undefined : refusedUrl(at.href, own, allow);
    if (refused) throw new Error(refused);
    const res = await fetchImpl(at.href, { ...request, redirect: "manual" });
    const location = res.headers.get("location");
    if (!REDIRECTS.has(res.status) || !location) return res;
    const next = new URL(location, at);
    await res.body?.cancel();
    if (next.origin !== at.origin) return { status: res.status, elsewhere: next.href };
    if (hop >= REDIRECTS_MAX) throw new Error(`more than ${REDIRECTS_MAX} redirects`);
    request = afterRedirect(res.status, request);
    at = next;
  }
}

/**
 * The `http.fetch` tool module: fetch a URL, with a timeout and a size cap.
 * Secrets are referenced by name ({{secret:name}}) in a header or the URL's
 * query string and injected by the harness at call time, so the model never
 * sees the real value. The
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
  const allow = (): LanAllow => parseLanAllow(options.lan?.(), kosPorts());
  const resolved = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    fetchImpl: options.fetchImpl ?? (options.local ? fetch : publicFetch(allow)),
    own: options.local ? () => LOCAL : (options.ownHosts ?? (() => [])),
    allow,
  };

  return {
    manifest: {
      name: "http",
      version: "1.0.0",
      provides: [{ kind: "tool", name: "http.fetch", version: "1.0.0" }],
      riskTier: "risky",
    },
    activate(ctx) {
      ctx.registerTool(
        {
          name: "http.fetch",
          description:
            "Fetch a URL. A read from a host on the owner's list runs at once; any other host, and any write, asks the owner first, and a yes they remember stands for that host. " +
            "Reference a secret by name as {{secret:name}} in a header or in the URL's query string, nowhere else; the harness injects the real value.",
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
        (input) => doFetch(input, resolved),
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
        { secretSlots: HTTP_SECRET_SLOTS },
      );
    },
  };
}
