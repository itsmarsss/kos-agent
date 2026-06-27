import { createServer, type Server } from "node:http";

import type { Kernel } from "./kernel.js";

export interface ApiRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * The dashboard backend as a pure request handler (no socket), so it is
 * testable without binding a port. It exposes the control-tower view of KOS
 * (status, approvals, projects, activity, crons, failed runs) plus controls
 * (approve/deny, kill switch, prompt box). Project content lives in agent-built
 * pages, not here.
 */
export async function handleApiRequest(
  kernel: Kernel,
  req: ApiRequest,
): Promise<ApiResponse> {
  const { method, path } = req;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ok = (b: unknown): ApiResponse => ({ status: 200, body: b });

  if (method === "GET" && path === "/api/status") {
    return ok({
      halted: kernel.killSwitch.halted,
      queueDepth: kernel.queue.depth,
      crons: kernel.crons.list().length,
      pendingApprovals: kernel.approvals.pending().length,
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
    return ok(await kernel.handleMessage(text));
  }

  return { status: 404, body: { error: "not found" } };
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

/**
 * Bind the dashboard API to an HTTP server. CORS is open for localhost dev; the
 * UI is served separately (vite dev) or as static assets in front of this.
 */
export function createDashboardServer(kernel: Kernel): Server {
  return createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const body = method === "GET" ? undefined : await readBody(req);
      const result = await handleApiRequest(kernel, { method, path, body });
      res.writeHead(result.status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      res.end(JSON.stringify(result.body));
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
}
