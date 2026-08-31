import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, normalize, relative, resolve, sep } from "node:path";

import type { MutationTarget, PageSpec, Widget } from "@kos/shared";

import { runDisplayQuery } from "../systems/display.js";
import { executeMutation, type WidgetEdit } from "../widgets/mutation.js";
import type { Kernel } from "./kernel.js";
import { primarySessionId } from "./session.js";
import { orchestratorId } from "./kernel.js";
import { parseAttachments } from "./attachments.js";
import cron from "node-cron";
import type { CreateCronInput, ToolCall } from "../cron/types.js";
import { findMentions, type MentionKind } from "./mentions.js";
import { CHAT_COMMANDS } from "./chatcommands.js";
import {
  EFFORTS,
  MODEL_SETTINGS_KEY,
  parseModelSettings,
} from "../models/settings.js";
import { conversationEvents } from "./transcript.js";
import { listDirectory, readFile } from "./files.js";

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
   * Optional bearer/token for every API route, reads included. When set,
   * requests must send `Authorization: Bearer <token>` or `x-kos-token: <token>`.
   */
  token?: string;
  /** Bind policy hint for logs; enforcement is host-level. Default loopback. */
  host?: string;
  /** Hosted-mode metadata for /api/health and /api/status (daemon). */
  meta?: DaemonMeta;
  /**
   * Explicit cross-origin allowlist. The dashboard is same-origin (the server
   * serves the built UI itself), so this is empty by default and no CORS
   * headers are sent; a wildcard would let any page in the browser reach the
   * loopback daemon.
   */
  allowedOrigins?: string[];
}

/** Widget types that may carry a guarded mutation target. */
const WRITE_CAPABLE = new Set(["list", "card", "form"]);

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

  // A configured token guards every route. Reads leak workspace state just as
  // surely as writes change it. With no token the server is loopback-only.
  if (options.token && !authorized(req, options.token)) {
    return { status: 401, body: { error: "unauthorized" } };
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
      orchestratorId: orchestratorId(kernel.profile.ownerId),
      routes: kernel.routes() ?? null,
    });
  }

  if (method === "GET" && path === "/api/settings/models") {
    return ok({
      routes: kernel.routes() ?? null,
      saved: kernel.settings.get(MODEL_SETTINGS_KEY) ?? {},
      efforts: EFFORTS,
    });
  }

  if (method === "POST" && path === "/api/settings/models") {
    const settings = parseModelSettings(body);
    kernel.settings.set(MODEL_SETTINGS_KEY, settings);
    // Applied in place: the owner changing a model should not have to restart
    // the host to see it take effect.
    kernel.applyModelSettings(settings);
    return ok({ saved: settings, routes: kernel.routes() ?? null });
  }

  if (method === "GET" && path === "/api/models") {
    try {
      return ok({ models: await kernel.availableModels() });
    } catch (err) {
      return {
        status: 502,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "GET" && path === "/api/approvals") {
    return ok(kernel.approvals.pending());
  }

  if (method === "GET" && path === "/api/projects") {
    return ok(kernel.manifest.list());
  }

  if (method === "GET" && path === "/api/activity") {
    const limit = clampLimit(queryParams(req.url).get("limit"), 100);
    return ok({
      tools: kernel.audit.recent(limit),
      runs: kernel.runs.recent(limit),
    });
  }

  if (method === "GET" && path === "/api/crons") {
    return ok(kernel.crons.list());
  }

  if (method === "POST" && path === "/api/crons/enable") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) {
      return { status: 400, body: { error: "id required" } };
    }
    const enabled = body.enabled !== false;
    kernel.crons.setEnabled(id, enabled);
    kernel.reloadCron();
    return ok({ id, enabled });
  }

  if (
    method === "POST" &&
    (path === "/api/crons/create" || path === "/api/crons/update")
  ) {
    // The owner writing a schedule by hand is not the agent proposing one, so
    // it takes effect without the approval queue. It still goes through the
    // same validation, including the read-only rule on the query.
    const input = parseCronInput(body);
    if (typeof input === "string") {
      return { status: 400, body: { error: input } };
    }
    try {
      const job =
        path === "/api/crons/update"
          ? kernel.crons.update(Number(body.id), input)
          : kernel.crons.create(input);
      if (!job) return { status: 404, body: { error: "no such job" } };
      kernel.reloadCron();
      return ok(job);
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "POST" && path === "/api/crons/delete") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) {
      return { status: 400, body: { error: "id required" } };
    }
    const removed = kernel.crons.delete(id);
    if (removed) kernel.reloadCron();
    return ok({ id, removed });
  }

  if (method === "GET" && path === "/api/runs") {
    const limit = clampLimit(queryParams(req.url).get("limit"), 100);
    const onlyFailed = queryParams(req.url).get("failed") === "1";
    return ok(
      onlyFailed ? kernel.runs.failures(limit) : kernel.runs.recent(limit),
    );
  }

  if (method === "GET" && path === "/api/failed") {
    const limit = clampLimit(queryParams(req.url).get("limit"), 100);
    return ok(kernel.runs.failures(limit));
  }

  if (method === "POST" && path === "/api/projects/status") {
    const slug = typeof body.slug === "string" ? body.slug : "";
    const status = typeof body.status === "string" ? body.status : "";
    const allowed = new Set([
      "born",
      "active",
      "dormant",
      "done",
      "archived",
    ]);
    if (!slug || !allowed.has(status)) {
      return {
        status: 400,
        body: { error: "slug and valid status required" },
      };
    }
    if (!kernel.manifest.get(slug)) {
      return { status: 404, body: { error: "project not found" } };
    }
    kernel.manifest.setStatus(
      slug,
      status as "born" | "active" | "dormant" | "done" | "archived",
    );
    return ok(kernel.manifest.get(slug));
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
    const { data, errors } = await loadPageData(kernel, got.spec);
    return ok({ record: got.record, spec: got.spec, data, errors });
  }

  if (method === "POST" && path === "/api/query") {
    const sql = typeof body.sql === "string" ? body.sql : "";
    if (!sql) return { status: 400, body: { error: "sql required" } };
    try {
      return ok(runDisplayQuery(kernel.workspace.reader, sql));
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "POST" && path === "/api/mutate") {
    // The caller names a widget; the target comes from the stored spec, never
    // from the request. A widget can only mutate what it declared.
    const pageId = typeof body.pageId === "string" ? body.pageId : "";
    const widgetIndex = Number(body.widgetIndex);
    if (!pageId || !Number.isInteger(widgetIndex) || widgetIndex < 0) {
      return {
        status: 400,
        body: { error: "pageId and widgetIndex required" },
      };
    }
    const page = kernel.pages.get(pageId);
    if (!page) return { status: 404, body: { error: "page not found" } };
    const widget = page.spec.widgets[widgetIndex];
    if (!widget) return { status: 404, body: { error: "widget not found" } };
    if (!WRITE_CAPABLE.has(widget.type)) {
      return { status: 403, body: { error: "widget is not write-capable" } };
    }
    const target = (widget as { mutate?: MutationTarget }).mutate;
    if (!target) {
      return {
        status: 403,
        body: { error: "widget declares no mutation target" },
      };
    }

    const values = (body.values ?? {}) as Record<string, unknown>;
    const key =
      body.key && typeof body.key === "object"
        ? (body.key as { column: string; value: unknown })
        : undefined;
    let edit: WidgetEdit;
    if (body.op === "insert") edit = { op: "insert", values };
    else if (body.op === "update") {
      if (!key) return { status: 400, body: { error: "key required for update" } };
      edit = { op: "update", key, values };
    } else if (body.op === "delete") {
      if (!key) return { status: 400, body: { error: "key required for delete" } };
      edit = { op: "delete", key };
    } else {
      return { status: 400, body: { error: "invalid op" } };
    }

    try {
      return ok(executeMutation(kernel.workspace.db, target, edit));
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
    return ok(await kernel.deny(id));
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
    // The orchestrator is reachable from the chat list like any other thread,
    // and it has to be the same agent there as it is under cmd-K. Routing on
    // the id keeps one definition of what it can do instead of two doors with
    // different toolkits behind them.
    const attachments = parseAttachments(body.attachments);
    try {
      if (sessionId === orchestratorId(kernel.profile.ownerId)) {
        return ok(
          await kernel.handleOrchestratorTurn(text, {
            channel: "dashboard",
            attachments,
          }),
        );
      }
      return ok(
        await kernel.handleMessage(text, { sessionId, userId, attachments }),
      );
    } catch (err) {
      // An attachment we cannot send is the caller's problem to fix, not a
      // server fault, and they need to be told which file and why.
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "POST" && path === "/api/orchestrator") {
    const text = typeof body.text === "string" ? body.text : "";
    if (text === "") return { status: 400, body: { error: "text required" } };
    try {
      return ok(
        await kernel.handleOrchestratorTurn(text, {
          channel: "dashboard",
          attachments: parseAttachments(body.attachments),
        }),
      );
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "GET" && path === "/api/files") {
    // The path comes from the client, so it goes through the jail; a traversal
    // attempt throws there rather than being sanitised here.
    const target = queryParams(req.url).get("path") ?? ".";
    try {
      return ok({ path: target, entries: listDirectory(kernel.workspace, target) });
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "GET" && path === "/api/file") {
    const target = queryParams(req.url).get("path") ?? "";
    if (!target) return { status: 400, body: { error: "path required" } };
    try {
      return ok(readFile(kernel.workspace, target));
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "POST" && path === "/api/workspace/open") {
    // Reveals the workspace in the desktop file manager. The path is the
    // kernel's own root, never anything from the request, so this cannot be
    // pointed at an arbitrary directory.
    const target = kernel.workspace.root;
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(opener, [target], (err) => (err ? reject(err) : resolve()));
      });
      return ok({ opened: target });
    } catch (err) {
      return {
        status: 500,
        body: {
          error: `could not open ${target}: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
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

  if (method === "POST" && path === "/api/conversations/stop") {
    const id = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!id) return { status: 400, body: { error: "sessionId required" } };
    return ok({ stopping: kernel.stop(id) });
  }

  if (method === "POST" && path === "/api/conversations/rewind") {
    const id = typeof body.sessionId === "string" ? body.sessionId : "";
    const index = Number(body.index);
    if (!id || !Number.isInteger(index) || index < 0) {
      return { status: 400, body: { error: "sessionId and index required" } };
    }
    try {
      return ok(
        await kernel.rewind(id, index, {
          ...(typeof body.text === "string" ? { text: body.text } : {}),
          ...(typeof body.forkTitle === "string" ? { forkTitle: body.forkTitle } : {}),
        }),
      );
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "GET" && path === "/api/mentions") {
    const params = queryParams(req.url);
    const q = params.get("q") ?? "";
    const kind = params.get("kind");
    const kinds = ["project", "page", "file", "schedule"];
    return ok({
      mentions: findMentions(
        {
          projects: kernel.manifest.list(),
          pages: kernel.pages.list(),
          crons: kernel.crons.list(),
          workspace: kernel.workspace,
        },
        q,
        12,
        kind && kinds.includes(kind) ? (kind as MentionKind) : undefined,
      ),
      commands: CHAT_COMMANDS,
    });
  }

  if (method === "GET" && path === "/api/conversations") {
    const includeArchived = queryParams(req.url).get("archived") === "1";
    // The orchestrator is included and labelled rather than filtered out: the
    // owner should be able to open the thread that routes their work. The
    // agent-facing chats.list still hides it, because it must not offer its
    // own thread as somewhere to put work.
    const orchestrator = orchestratorId(kernel.profile.ownerId);
    // Each row says what it is doing. Without this a thread that is mid-turn
    // or sitting on an approval looks exactly like one with nothing happening,
    // and the only way to find out was to open it.
    const busy = new Set(kernel.busyConversations());
    const waiting = new Set(
      kernel.approvals
        .pending()
        .map((a) => a.conversationId)
        .filter((id): id is string => typeof id === "string"),
    );
    return ok(
      kernel.conversations
        .list(kernel.profile.ownerId, { includeArchived })
        .map((c) => ({
          ...c,
          kind: c.id === orchestrator ? "orchestrator" : "chat",
          activity: busy.has(c.id)
            ? "working"
            : waiting.has(c.id)
              ? "needs-you"
              : "idle",
        })),
    );
  }

  if (method === "GET" && path.startsWith("/api/conversations/")) {
    // Transcript for one conversation, so switching in the UI shows history
    // rather than an empty pane.
    const id = decodeURIComponent(
      path.slice("/api/conversations/".length).replace(/\/messages$/, ""),
    );
    if (!kernel.conversations.get(id)) {
      return { status: 404, body: { error: "conversation not found" } };
    }
    // Events, not just spoken turns: a chat view that hides the tool calls
    // shows conclusions with no visible working.
    return ok({
      id,
      messages: transcriptOf(kernel, id),
      events: conversationEvents(kernel.sessions.get(id)),
    });
  }

  if (method === "POST" && path === "/api/conversations/new") {
    const title = typeof body.title === "string" ? body.title : undefined;
    const created = kernel.conversations.create({
      userId: kernel.profile.ownerId,
      channel: "dashboard",
      ...(title ? { title } : {}),
    });
    kernel.conversations.setActive("dashboard", kernel.profile.ownerId, created.id);
    return ok(created);
  }

  if (method === "GET" && path === "/api/tools") {
    // Powers the tool-scope editor: the owner picks from what actually exists.
    return ok(
      kernel.registry
        .defs()
        .map((d) => ({ name: d.name, description: d.description })),
    );
  }

  if (method === "POST" && path === "/api/conversations/configure") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    if (!kernel.conversations.get(id)) {
      return { status: 404, body: { error: "conversation not found" } };
    }
    const config: { brief?: string | null; toolAllow?: string[] | null } = {};
    if (typeof body.brief === "string") config.brief = body.brief;
    else if (body.brief === null) config.brief = null;
    // null clears the scope; an array sets it, empty included.
    if (body.toolAllow === null) config.toolAllow = null;
    else if (Array.isArray(body.toolAllow)) {
      config.toolAllow = (body.toolAllow as unknown[]).filter(
        (x): x is string => typeof x === "string",
      );
    }
    return ok(kernel.conversations.configure(id, config));
  }

  if (method === "POST" && path === "/api/conversations/rename") {
    const id = typeof body.id === "string" ? body.id : "";
    const title = typeof body.title === "string" ? body.title : "";
    if (!id || !title) {
      return { status: 400, body: { error: "id and title required" } };
    }
    const renamed = kernel.conversations.rename(id, title);
    if (!renamed) return { status: 404, body: { error: "conversation not found" } };
    return ok(renamed);
  }

  if (method === "POST" && path === "/api/conversations/archive") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    const updated = kernel.conversations.setArchived(id, body.archived !== false);
    if (!updated) return { status: 404, body: { error: "conversation not found" } };
    return ok(updated);
  }

  if (method === "POST" && path === "/api/conversations/delete") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    return ok({ id, removed: kernel.conversations.remove(id) });
  }

  if (method === "GET" && path === "/api/memory") {
    const limit = clampLimit(queryParams(req.url).get("limit"), 200);
    return ok({
      facts: kernel.facts.all(kernel.profile.ownerId).slice(0, limit),
      tags: kernel.facts.tags(kernel.profile.ownerId),
    });
  }

  if (method === "POST" && path === "/api/memory/pin") {
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) return { status: 400, body: { error: "key required" } };
    const updated = kernel.facts.setPinned(
      kernel.profile.ownerId,
      key,
      body.pinned !== false,
    );
    if (!updated) return { status: 404, body: { error: "not found" } };
    return ok(updated);
  }

  if (method === "POST" && path === "/api/memory") {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";
    const kind = body.kind === "preference" ? "preference" : "fact";
    if (!key || value === "") {
      return { status: 400, body: { error: "key and value required" } };
    }
    const tags = Array.isArray(body.tags)
      ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined;
    kernel.facts.upsert(
      kernel.profile.ownerId,
      {
        key,
        value,
        kind,
        ...(tags ? { tags } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
      },
      "dashboard",
    );
    return ok(kernel.facts.get(kernel.profile.ownerId, key));
  }

  if (method === "POST" && path === "/api/memory/delete") {
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) return { status: 400, body: { error: "key required" } };
    const removed = kernel.facts.delete(kernel.profile.ownerId, key);
    return ok({ key, removed });
  }

  return { status: 404, body: { error: "not found" } };
}

/**
 * Flatten a stored transcript to the {role, text} pairs a chat view needs.
 * Tool round-trips are kept in the session for the model but are noise here,
 * so only spoken turns come back.
 */
function transcriptOf(
  kernel: Kernel,
  id: string,
): Array<{ role: "you" | "kos"; text: string }> {
  const out: Array<{ role: "you" | "kos"; text: string }> = [];
  for (const message of kernel.sessions.get(id)) {
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
    if (text === "") continue;
    out.push({ role: message.role === "user" ? "you" : "kos", text });
  }
  return out;
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

function queryParams(url?: string): URLSearchParams {
  if (!url || !url.includes("?")) return new URLSearchParams();
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

function projectFromUrl(url?: string): string | undefined {
  return queryParams(url).get("project") ?? undefined;
}

function clampLimit(raw: string | null, fallback: number): number {
  // Number(null) is 0, which is finite, so an absent parameter used to clamp
  // to 1 and every one of these endpoints returned a single row.
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

interface PageData {
  /** Rows per widget index, for widgets whose query succeeded. */
  data: Record<number, Record<string, unknown>[]>;
  /** Query failure message per widget index, so a broken widget is visible. */
  errors: Record<number, string>;
}

async function loadPageData(kernel: Kernel, spec: PageSpec): Promise<PageData> {
  const data: PageData["data"] = {};
  const errors: PageData["errors"] = {};
  for (let i = 0; i < spec.widgets.length; i++) {
    const w = spec.widgets[i] as Widget & { query?: string };
    if (typeof w.query === "string" && w.query.trim()) {
      try {
        data[i] = runDisplayQuery(kernel.workspace.reader, w.query).rows;
      } catch (err) {
        // An empty result and a broken query must not look the same.
        data[i] = [];
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return { data, errors };
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
 * Turn progress as server-sent events.
 *
 * A turn runs for tens of seconds across several tool calls, and a reader
 * polling every five seconds sees none of it. The stream carries what step the
 * agent is on; anything that has to survive a reconnect stays in the polled
 * conversation list, so a dropped connection loses nothing but liveness.
 */
function streamProgress(
  kernel: Kernel,
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardServerOptions,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...corsHeaders(req, options),
  });
  res.write(": connected\n\n");

  const unsubscribe = kernel.progress.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  // Proxies and browsers drop a silent stream; a comment costs nothing and is
  // ignored by EventSource.
  const beat = setInterval(() => res.write(": beat\n\n"), 25_000);

  const close = (): void => {
    clearInterval(beat);
    unsubscribe();
  };
  req.on("close", close);
  res.on("close", close);
}


/**
 * Check a schedule the owner wrote, returning the reason when it cannot be
 * used. The same shape the tool accepts, minus the approval queue: this is the
 * owner acting directly.
 */
function parseCronInput(body: Record<string, unknown>): CreateCronInput | string {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const schedule = typeof body.schedule === "string" ? body.schedule.trim() : "";
  if (!name) return "name required";
  if (!cron.validate(schedule)) return `invalid cron schedule: ${schedule || "(empty)"}`;

  const type = body.type === "self_prompt" ? "self_prompt" : "actions";
  const input: CreateCronInput = { name, schedule, type };
  if (typeof body.query === "string" && body.query.trim()) input.query = body.query;
  if (typeof body.projectSlug === "string" && body.projectSlug) {
    input.projectSlug = body.projectSlug;
  }

  if (type === "self_prompt") {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return "a self_prompt job needs a prompt";
    input.prompt = prompt;
    return input;
  }

  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    return "an actions job needs at least one tool call";
  }
  const actions: ToolCall[] = [];
  for (const [i, entry] of body.actions.entries()) {
    if (typeof entry !== "object" || entry === null) return `actions[${i}] must be an object`;
    const call = entry as Record<string, unknown>;
    if (typeof call.tool !== "string" || !call.tool) return `actions[${i}] needs a tool`;
    const args = call.args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return `actions[${i}]: args must be an object`;
    }
    actions.push({
      tool: call.tool,
      args: (args as Record<string, unknown> | undefined) ?? {},
    });
  }
  input.actions = actions;
  return input;
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
  // Vite fingerprints everything under assets/, so those are safe to keep
  // forever. index.html is not fingerprinted, and with no header at all the
  // browser cached it heuristically: an updated KOS kept serving the old app
  // until someone thought to hard-reload.
  const fingerprinted = relative(root, file).split(sep)[0] === "assets";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": fingerprinted
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
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
        res.writeHead(204, corsHeaders(req, options));
        res.end();
        return;
      }

      // Server-sent events need the raw response, so this cannot go through
      // the JSON handler that every other route uses.
      if (method === "GET" && path === "/api/events") {
        streamProgress(kernel, req, res, options);
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
          ...corsHeaders(req, options),
          ...(result.headers ?? {}),
        });
        if (result.body === null) res.end();
        else res.end(JSON.stringify(result.body));
        return;
      }

      if (options.staticDir && (method === "GET" || method === "HEAD")) {
        if (tryStatic(options.staticDir, path, res)) return;
      }

      res.writeHead(404, { "content-type": "application/json", ...corsHeaders(req, options) });
      res.end(JSON.stringify({ error: "not found" }));
    })().catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
}

/**
 * Same-origin by default: no allow-origin header at all, so a browser refuses
 * cross-site reads of the loopback daemon. Cross-origin access is opt-in via
 * an explicit allowlist and is echoed back only for an origin on that list.
 */
function corsHeaders(
  req: IncomingMessage,
  options: DashboardServerOptions,
): Record<string, string> {
  const allowed = options.allowedOrigins ?? [];
  if (allowed.length === 0) return {};
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !allowed.includes(origin)) {
    return { vary: "origin" };
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type, authorization, x-kos-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin",
  };
}
