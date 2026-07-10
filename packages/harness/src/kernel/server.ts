import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import type { PageSpec, Widget } from "@kos/shared";

import { runDisplayQuery } from "../systems/display.js";
import { executeMutation, type WidgetEdit } from "../widgets/mutation.js";
import type { Kernel } from "./kernel.js";
import { primarySessionId } from "./session.js";

export interface ApiRequest {
  method: string;
  path: string;
  body?: unknown;
  /** Raw URL path including query string for token checks if needed. */
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface DaemonMeta {
  /** Process id of the multi-modal host (kos start). */
  pid?: number;
  /** Discord adapter is connected. */
  discord?: boolean;
  /** Cron scheduler is running. */
  cron?: boolean;
  workspace?: string;
}

export interface DashboardServerOptions {
  /** Directory of built UI assets (vite dist). When set, non-/api paths are served. */
  staticDir?: string;
  /**
   * Optional bearer/token for mutating API routes. When set, requests must send
   * `Authorization: Bearer <token>` or `x-kos-token: <token>`.
   */
  token?: string;
  /** Bind policy hint for logs; enforcement is host-level. Default loopback. */
  host?: string;
  /** Hosted-mode metadata for /api/health and /api/status (daemon). */
  meta?: DaemonMeta;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The dashboard backend as a pure request handler (no socket), so it is
 * testable without binding a port. It exposes the control-tower view of KOS
 * (status, approvals, projects, activity, crons, failed runs) plus controls
 * (approve/deny, kill switch, prompt box), page specs, and read-only display
 * queries.
 */
export async function handleApiRequest(
  kernel: Kernel,
  req: ApiRequest,
  options: DashboardServerOptions = {},
): Promise<ApiResponse> {
  const { method, path } = req;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ok = (b: unknown): ApiResponse => ({ status: 200, body: b });

  if (method === "OPTIONS") {
    return { status: 204, body: null };
  }

  if (options.token && !SAFE_METHODS.has(method)) {
    if (!authorized(req, options.token)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
  }

  if (method === "GET" && path === "/api/health") {
    return ok({
      ok: true,
      pid: options.meta?.pid ?? process.pid,
      discord: options.meta?.discord === true,
      cron: options.meta?.cron !== false,
      workspace: options.meta?.workspace ?? kernel.workspace.root,
    });
  }

  if (method === "GET" && path === "/api/status") {
    return ok({
      halted: kernel.killSwitch.halted,
      queueDepth: kernel.queue.depth,
      crons: kernel.crons.list().length,
      pendingApprovals: kernel.approvals.pending().length,
      projects: kernel.manifest.list().length,
      pages: kernel.pages.list().length,
      discord: options.meta?.discord === true,
      pid: options.meta?.pid ?? process.pid,
      workspace: options.meta?.workspace ?? kernel.workspace.root,
    });
  }

  if (method === "GET" && path === "/api/approvals") {
    return ok(kernel.approvals.pending());
  }

  if (method === "GET" && path === "/api/projects") {
    return ok(kernel.manifest.list());
  }

  if (method === "GET" && path === "/api/activity") {
    return ok({
      tools: kernel.audit.recent(20),
      runs: kernel.runs.recent(20),
    });
  }

  if (method === "GET" && path === "/api/crons") {
    return ok(kernel.crons.list());
  }

  if (method === "GET" && path === "/api/failed") {
    return ok(kernel.runs.failures(20));
  }

  if (method === "GET" && path === "/api/pages") {
    const project =
      typeof (body as { project?: unknown }).project === "string"
        ? (body as { project: string }).project
        : undefined;
    // Query string project= is not in body for GET; parse from url if present.
    const qsProject = projectFromUrl(req.url);
    return ok(kernel.pages.list(qsProject ?? project));
  }

  if (method === "GET" && path.startsWith("/api/pages/")) {
    const id = decodeURIComponent(path.slice("/api/pages/".length));
    const got = kernel.pages.get(id);
    if (!got) return { status: 404, body: { error: "page not found" } };
    const data = await loadPageData(kernel, got.spec);
    return ok({ record: got.record, spec: got.spec, data });
  }

  if (method === "POST" && path === "/api/query") {
    const sql = typeof body.sql === "string" ? body.sql : "";
    if (!sql) return { status: 400, body: { error: "sql required" } };
    try {
      return ok(runDisplayQuery(kernel.workspace.db, sql));
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "POST" && path === "/api/mutate") {
    const table = typeof body.table === "string" ? body.table : "";
    const columns = Array.isArray(body.columns)
      ? (body.columns as string[])
      : [];
    const op = body.op as WidgetEdit["op"];
    const values = (body.values ?? {}) as Record<string, unknown>;
    const key =
      body.key && typeof body.key === "object"
        ? (body.key as { column: string; value: unknown })
        : undefined;
    if (!table || !op || columns.length === 0) {
      return {
        status: 400,
        body: { error: "table, op, and columns required" },
      };
    }
    try {
      let edit: WidgetEdit;
      if (op === "insert") edit = { op: "insert", values };
      else if (op === "update") {
        if (!key) return { status: 400, body: { error: "key required for update" } };
        edit = { op: "update", key, values };
      } else if (op === "delete") {
        if (!key) return { status: 400, body: { error: "key required for delete" } };
        edit = { op: "delete", key };
      } else {
        return { status: 400, body: { error: "invalid op" } };
      }
      const result = executeMutation(kernel.workspace.db, {
        table,
        columns,
        allow: ["insert", "update", "delete"],
      }, edit);
      return ok(result);
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "POST" && path === "/api/approve") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    return ok(await kernel.approve(id));
  }

  if (method === "POST" && path === "/api/deny") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    return ok(kernel.deny(id));
  }

  if (method === "POST" && path === "/api/kill") {
    if (body.halted) kernel.killSwitch.halt();
    else kernel.killSwitch.resume();
    return ok({ halted: kernel.killSwitch.halted });
  }

  if (method === "POST" && path === "/api/message") {
    const text = typeof body.text === "string" ? body.text : "";
    if (text === "") return { status: 400, body: { error: "text required" } };
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : primarySessionId(kernel.profile.ownerId);
    const userId =
      typeof body.userId === "string" && body.userId.length > 0
        ? body.userId
        : kernel.profile.ownerId;
    return ok(await kernel.handleMessage(text, { sessionId, userId }));
  }

  if (method === "POST" && path === "/api/clear") {
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : primarySessionId(kernel.profile.ownerId);
    kernel.clearSession(sessionId);
    return ok({ cleared: sessionId });
  }

  if (method === "POST" && path === "/api/snapshot") {
    await kernel.backup.ensureRepo();
    const message =
      typeof body.message === "string" && body.message.length > 0
        ? body.message
        : undefined;
    const sha = await kernel.backup.snapshot(message);
    return ok({ sha });
  }

  if (method === "GET" && path === "/api/memory") {
    return ok({ facts: kernel.facts.all(kernel.profile.ownerId).slice(0, 20) });
  }

  return { status: 404, body: { error: "not found" } };
}

function authorized(req: ApiRequest, token: string): boolean {
  const headers = req.headers ?? {};
  const auth = header(headers, "authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7) === token) return true;
  const x = header(headers, "x-kos-token");
  return x === token;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function projectFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const params = new URLSearchParams(q);
  return params.get("project") ?? undefined;
}

async function loadPageData(
  kernel: Kernel,
  spec: PageSpec,
): Promise<Record<number, Record<string, unknown>[]>> {
  const data: Record<number, Record<string, unknown>[]> = {};
  for (let i = 0; i < spec.widgets.length; i++) {
    const w = spec.widgets[i] as Widget & { query?: string };
    if (typeof w.query === "string" && w.query.trim()) {
      try {
        data[i] = runDisplayQuery(kernel.workspace.db, w.query).rows;
      } catch {
        data[i] = [];
      }
    }
  }
  return data;
}

async function readBody(stream: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function tryStatic(
  staticDir: string,
  urlPath: string,
  res: ServerResponse,
): boolean {
  const clean = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  // Strip leading slash so resolve(staticDir, rel) does not ignore staticDir.
  let rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  rel = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const root = resolve(staticDir);
  let file = resolve(root, rel);
  if (!file.startsWith(root + sep) && file !== root) {
    return false;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, "index.html");
    if (!existsSync(file)) return false;
  }
  const type = MIME[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Bind the dashboard API (and optional static UI) to an HTTP server.
 * Prefer binding to 127.0.0.1 unless you set an auth token.
 */
export function createDashboardServer(
  kernel: Kernel,
  options: DashboardServerOptions = {},
): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? "GET";
      const rawUrl = req.url ?? "/";
      const path = rawUrl.split("?")[0] ?? "/";

      if (method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      if (path.startsWith("/api")) {
        const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
        const result = await handleApiRequest(
          kernel,
          {
            method,
            path,
            body,
            url: rawUrl,
            headers: req.headers as Record<string, string | string[] | undefined>,
          },
          options,
        );
        res.writeHead(result.status, {
          "content-type": "application/json",
          ...corsHeaders(),
          ...(result.headers ?? {}),
        });
        if (result.body === null) res.end();
        else res.end(JSON.stringify(result.body));
        return;
      }

      if (options.staticDir && (method === "GET" || method === "HEAD")) {
        if (tryStatic(options.staticDir, path, res)) return;
      }

      res.writeHead(404, { "content-type": "application/json", ...corsHeaders() });
      res.end(JSON.stringify({ error: "not found" }));
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-kos-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}
