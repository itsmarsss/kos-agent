import { isValidIdentifier, type ApiRequest, type ApiResponse, type ApprovalDecision, type ApprovalHandler, type AuditEntry } from "@kos/harness";
import { ARTIFACT_ID_RE } from "@kos/shared";

import { ARTIFACT_DOCUMENT_BYTES } from "./artifacts.js";

/**
 * The dashboard's own pages, on a device that has no dashboard: KOS for
 * iPhone. A phone asks one of the dashboard's routes by its path, and the
 * dashboard's own handler answers it, so every page on the phone (Inbox,
 * Projects, Artifacts, Blobs, Files, Memory, Runs, Overview) reads what the
 * dashboard reads, through one door. The door is narrow: the reads listed
 * here with the query keys each takes, and a few named actions with exactly
 * their bodies. Anything else is refused before it reaches the handler.
 */

/** What the host gives a phone's panel: the dashboard's handler, asked as the owner, with no token and no Origin. */
export type PanelDashboard = (req: ApiRequest) => Promise<ApiResponse>;

/** What a named action's body holds: each key's type, `?` when it may be left out. */
type BodyKey = "integer" | "boolean" | "boolean?";

/** An approval is decided as the phone's own chat.decide is, never through the handler; the rest go through it. */
type RouteKind = "read" | "action" | "approve" | "deny";

interface Route {
  method: "GET" | "POST";
  /** The path, a `<name>` standing for a segment its check below takes. */
  path: string;
  kind: RouteKind;
  query?: readonly string[];
  body?: Readonly<Record<string, BodyKey>>;
  /** What the handler is also told, never what the phone said: Run now's answer once it fires, not once it ends. */
  adds?: Readonly<Record<string, unknown>>;
}

const read = (path: string, query: readonly string[] = []): Route => ({ method: "GET", path, kind: "read", query });
const action = (path: string, body: Record<string, BodyKey>, kind: RouteKind = "action"): Route => ({ method: "POST", path, kind, body });

/** Every route a phone may ask, and nothing else: reads, and the actions a phone's pages offer. */
const ROUTES: readonly Route[] = [
  read("/api/home"),
  read("/api/inbox"),
  read("/api/approvals"),
  read("/api/approvals/history", ["before", "status", "q", "limit"]),
  read("/api/approvals/history/counts"),
  read("/api/approvals/<digits>"),
  read("/api/projects"),
  read("/api/projects/<slug>/detail"),
  read("/api/artifacts", ["trashed"]),
  read("/api/artifacts/<artifact>/export", ["format", "tab", "theme"]),
  read("/api/agents"),
  // Reading a chat marks it read, as opening it on the dashboard does.
  read("/api/conversations/<conversation>/messages"),
  read("/api/files", ["path"]),
  read("/api/file", ["path"]),
  read("/api/file/text", ["path"]),
  read("/api/file/raw", ["path"]),
  read("/api/file/view", ["path"]),
  read("/api/memory", ["limit"]),
  read("/api/memory/trace", ["key"]),
  read("/api/runs", ["limit", "failed"]),
  read("/api/crons"),
  action("/api/approve", { id: "integer", remember: "boolean?" }, "approve"),
  action("/api/deny", { id: "integer" }, "deny"),
  // A run can take minutes, longer than a phone waits: it is answered once it fires, or why it did not.
  { ...action("/api/crons/run", { id: "integer" }), adds: { wait: false } },
  action("/api/crons/enable", { id: "integer", enabled: "boolean" }),
  action("/api/artifacts/<artifact>/restore", {}),
];

/** The longest name one segment of a path may give: a chat's id is the longest KOS makes. */
const SEGMENT_MAX = 160;
const PATH_MAX = 512;
const QUERY_VALUE_MAX = 1024;
/** How many asks one phone may have on the way at once. */
export const DASHBOARD_IN_FLIGHT = 4;
/** How long an ask holds its place: as long as a phone waits on one (KOS for iPhone, 25 s), so both free it together. */
export const DASHBOARD_SLOT_MS = 25_000;
/** The routes that answer a file's bytes, which a phone's line could not take past its bound. */
const FILE_BYTES = new Set(["/api/file/raw", "/api/file/view"]);

/** What each `<name>` in a route's path takes. A chat's id is as KOS makes them: `c…:owner`, `project:garden`, `agent:scout`, `cron:1`. */
const SEGMENTS: Record<string, (s: string) => boolean> = {
  "<digits>": (s) => /^\d{1,15}$/.test(s),
  "<slug>": isValidIdentifier,
  "<artifact>": (s) => ARTIFACT_ID_RE.test(s),
  "<conversation>": (s) => /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/.test(s),
};

const REFUSED = {
  notAllowed: "A phone cannot ask the dashboard for that.",
  query: "That asks the page for something it does not take.",
  body: "That is not what that action takes.",
  outside: "That file is not in the workspace.",
  busy: "The phone is asking for too much at once. Try again in a moment.",
  tooBig: "That is too big to show on a phone. Open it on the dashboard.",
  undecided: "Approvals cannot be decided from the phone right now.",
  notDecided: "That ask was not decided: it may be gone, or no longer yours to decide.",
} as const;

/** An ask let through: the request to make of the handler, and what kind of route it is. */
export interface DashboardAsk {
  kind: RouteKind;
  request: ApiRequest & { method: "GET" | "POST"; url: string };
  /** A named action's body, as checked. */
  body?: Record<string, unknown>;
}

/**
 * Whether a phone's ask goes through, and as what. The path is matched whole
 * against the routes; a path that could mean anything else to the handler (a
 * dot segment, an escape, a backslash, an empty segment, a query) is refused,
 * so what is matched is what the handler sees. Only the route's query keys
 * pass, each a short string, and a file's path never leaves the workspace by
 * its words (the handler's jail is the fence; this only keeps a traversal
 * from reaching it). A named action's body is exactly its keys.
 */
export function admit(data: Record<string, unknown>): DashboardAsk | { refused: string } {
  const { method, path, query, body } = data;
  if ((method !== "GET" && method !== "POST") || typeof path !== "string" || !wellFormed(path)) return { refused: REFUSED.notAllowed };
  const route = ROUTES.find((r) => r.method === method && matches(r.path, path));
  if (!route) return { refused: REFUSED.notAllowed };
  const params = queryOf(query, route.query ?? []);
  if (!params) return { refused: REFUSED.query };
  if (params.has("path") && !inWorkspace(params.get("path")!)) return { refused: REFUSED.outside };
  const search = params.toString();
  const request = { method: route.method, path, url: search ? `${path}?${search}` : path };
  if (!route.body) return body === undefined ? { kind: route.kind, request } : { refused: REFUSED.body };
  const given = bodyOf(body ?? {}, route.body);
  if (!given) return { refused: REFUSED.body };
  return { kind: route.kind, request: { ...request, body: { ...given, ...route.adds } }, body: given };
}

function wellFormed(path: string): boolean {
  if (path.length > PATH_MAX || !path.startsWith("/api/") || /[%\\?#\0]/.test(path)) return false;
  return path
    .slice(1)
    .split("/")
    .every((s) => s !== "" && s !== "." && s !== ".." && s.length <= SEGMENT_MAX);
}

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((w, i) => (w.startsWith("<") ? SEGMENTS[w]!(got[i]!) : w === got[i]));
}

/** The route's query keys as given, each a string; undefined when one is not the route's, or not a short string. */
function queryOf(query: unknown, keys: readonly string[]): URLSearchParams | undefined {
  const params = new URLSearchParams();
  if (query === undefined) return params;
  if (!isRecord(query)) return undefined;
  for (const [key, value] of Object.entries(query)) {
    if (!keys.includes(key) || typeof value !== "string" || value.length > QUERY_VALUE_MAX) return undefined;
    params.set(key, value);
  }
  return params;
}

/** A path in the workspace by its words: relative, and never stepping up. */
function inWorkspace(path: string): boolean {
  return !/^([/\\~]|[A-Za-z]:)/.test(path) && !path.split(/[/\\]/).includes("..") && !path.includes("\0");
}

/** Exactly the action's keys, each its type; undefined for anything more, less or else. */
function bodyOf(body: unknown, keys: Readonly<Record<string, BodyKey>>): Record<string, unknown> | undefined {
  if (!isRecord(body) || Object.keys(body).some((k) => !Object.hasOwn(keys, k))) return undefined;
  for (const [key, type] of Object.entries(keys)) {
    const value = body[key];
    if (value === undefined && type.endsWith("?")) continue;
    if (type === "integer" ? !Number.isSafeInteger(value) : typeof value !== "boolean") return undefined;
  }
  return body;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface DashboardDeps {
  ask: PanelDashboard;
  /** The panel's approval handler, as chat.decide reaches it; undefined while there is none to decide with. */
  decide(decision: ApprovalDecision): Promise<Awaited<ReturnType<ApprovalHandler>>> | undefined;
  audit?(entry: AuditEntry): void;
}

/**
 * Each phone's asks of the dashboard: a few at a time, each answered as the
 * route answers, its bytes as base64, within what a phone's line takes, and
 * every action written down as the phone's.
 */
export class DashboardRelay {
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly deps: DashboardDeps) {}

  /** Answer one ask with `reply`, or not at all for an ask that names no call to answer. */
  async answer(device: string, data: Record<string, unknown>, reply: (answer: Record<string, unknown>) => Promise<unknown>): Promise<void> {
    const call = data["call"];
    if (typeof call !== "number" || !Number.isInteger(call)) return;
    const busy = this.inFlight.get(device) ?? 0;
    if (busy >= DASHBOARD_IN_FLIGHT) return void (await reply({ call, error: REFUSED.busy }));
    this.inFlight.set(device, busy + 1);
    // Its place is given back once answered, or once the phone has stopped waiting, whichever is first.
    let held = true;
    const release = (): void => {
      if (!held) return;
      held = false;
      const left = (this.inFlight.get(device) ?? 1) - 1;
      if (left > 0) this.inFlight.set(device, left);
      else this.inFlight.delete(device);
    };
    const deadline = setTimeout(release, DASHBOARD_SLOT_MS);
    deadline.unref?.();
    try {
      await reply({ call, ...(await this.settle(device, data)) });
    } finally {
      clearTimeout(deadline);
      release();
    }
  }

  private async settle(device: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ask = admit(data);
    if ("refused" in ask) return { error: ask.refused };
    const { kind, request } = ask;
    // Every action is written down as the phone's; a read is not.
    const audit = (result: string, isError: boolean): void => {
      if (kind !== "read") this.deps.audit?.({ tool: "device.dashboard", args: { device, method: request.method, path: request.path, body: ask.body ?? {} }, result, isError });
    };
    try {
      if (kind === "approve" || kind === "deny") return await this.decide(device, ask.body!, kind === "approve", audit);
      if (FILE_BYTES.has(request.path) && !(await this.fits(new URLSearchParams(request.url.split("?")[1]).get("path") ?? ""))) return { error: REFUSED.tooBig };
      const response = await this.deps.ask(request);
      // An action the route answered as not done (Run now on a halted KOS, say) is written down as not done.
      audit(JSON.stringify(response.body ?? null), response.status >= 400 || (isRecord(response.body) && response.body["ok"] === false));
      return fitted(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit(message, true);
      return { error: message };
    }
  }

  /** An approval decided as the phone's chat.decide decides it, the phone as its decider, so it settles everywhere as a phone's decision does. */
  private async decide(device: string, body: Record<string, unknown>, approved: boolean, audit: (result: string, isError: boolean) => void): Promise<Record<string, unknown>> {
    const id = body["id"] as number;
    const remember = approved && body["remember"] === true;
    const deciding = this.deps.decide({ id: String(id), approved, deciderId: device, ...(remember ? { remember } : {}) });
    if (!deciding) {
      audit(REFUSED.undecided, true);
      return { error: REFUSED.undecided };
    }
    const settled = await deciding;
    // No outcome is no decision: an id that is not waiting, a decider who is not the owner, a handler that failed.
    if (!settled) {
      audit(REFUSED.notDecided, true);
      return { error: REFUSED.notDecided };
    }
    const answer = { id, approved, outcome: settled.outcome, ...(settled.already ? { already: true } : {}) };
    audit(JSON.stringify(answer), false);
    return { status: 200, body: answer };
  }

  /** Whether a file's bytes would fit a phone's line, by its size in its folder's listing, before any of them are read. */
  private async fits(path: string): Promise<boolean> {
    const cut = path.lastIndexOf("/");
    const folder = cut < 0 ? "." : path.slice(0, cut);
    const listed = await this.deps.ask({ method: "GET", path: "/api/files", url: `/api/files?${new URLSearchParams({ path: folder })}` });
    const entries = isRecord(listed.body) && Array.isArray(listed.body["entries"]) ? (listed.body["entries"] as unknown[]) : [];
    const entry = entries.find((e): e is { path: string; size: number } => isRecord(e) && e["path"] === path && typeof e["size"] === "number");
    // Not listed is the route's to refuse, in its own words.
    return !entry || Math.ceil(entry.size / 3) * 4 <= ARTIFACT_DOCUMENT_BYTES;
  }
}

/** A route's answer as it goes to the phone, JSON or bytes as base64; refused in words past what a phone's line takes. */
function fitted(response: ApiResponse): Record<string, unknown> {
  const { status, body } = response;
  let answer: Record<string, unknown>;
  if (body instanceof Uint8Array) {
    // Known before the bytes are encoded: a file far too big is never turned to base64.
    if (Math.ceil(body.byteLength / 3) * 4 > ARTIFACT_DOCUMENT_BYTES) return { error: REFUSED.tooBig };
    answer = { status, type: response.headers?.["content-type"] ?? "application/octet-stream", data: Buffer.from(body).toString("base64") };
  } else answer = { status, body: body ?? null };
  // Measured as it goes on the line, escaped and with everything around it.
  return Buffer.byteLength(JSON.stringify(answer), "utf8") > ARTIFACT_DOCUMENT_BYTES ? { error: REFUSED.tooBig } : answer;
}
