import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, normalize, relative, resolve, sep } from "node:path";

import { parseHomeLayout,
  CHAT_COMMANDS,
} from "@kos/shared";
import type { MutationTarget, PageSpec, Widget } from "@kos/shared";

import { runDisplayQuery } from "../systems/display.js";
import { executeMutation, type WidgetEdit } from "../widgets/mutation.js";
import type { Kernel } from "./kernel.js";
import { primarySessionId } from "./session.js";
import {
  BEHAVIOUR_DEFAULTS,
  BEHAVIOUR_KEY,
  BEHAVIOUR_LIMITS,
  parseBehaviour,
} from "./behaviour.js";
import { BUILD_SETTINGS_KEY, orchestratorId } from "./kernel.js";
import { parseAttachments } from "./attachments.js";
import cron from "node-cron";
import type { CreateCronInput, ToolCall } from "../cron/types.js";
import { findMentions, type MentionKind,
  walkFolders,
} from "./mentions.js";
import { } from "./chatcommands.js";
import {
  EFFORTS,
  MODEL_SETTINGS_KEY,
  parseModelSettings,
} from "../models/settings.js";
import { conversationEvents } from "./transcript.js";
import { listDirectory, readFile, readImage } from "./files.js";
import { listSites, listSitesFor, sitesBaseUrl, PROJECTS_DIR } from "../sites/server.js";
import { costOf, parseRates, windowFor, RATES_KEY } from "../ops/spend.js";
import { readSkills } from "../skills/manifest.js";
import { listPages, readPage } from "../memory/pages.js";
import { mayRead } from "../memory/callers.js";
import { GLOBAL_SCOPE, callerScope, type Fact } from "../memory/facts.js";
import { MODULES_KEY, parseModuleSettings, readWorkspaceModules, withModuleEnabled } from "../modules/workspace.js";
import { SKILLS_KEY, parseSkillSettings, withSkillEnabled } from "../skills/settings.js";
import { conversationKind } from "./conversations.js";
import { proxyToDaemon } from "../daemons/proxy.js";
import { RETENTION_DEFAULTS, RETENTION_KEY, cronSessionId } from "./session.js";

/** Where the owner's home arrangement lives. */
export const HOME_LAYOUT_KEY = "home.layout";
import { saveProfile } from "./profile.js";
import {
  findSecret,
  isInside,
  isWritableKey,
  maskSecret,
  namesFor,
  writeEnvFile,
  WRITABLE_SECRETS,
  WRITABLE_SETTINGS,
} from "../secrets/envfile.js";
import { contextWindowFor } from "../models/windows.js";

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
  /**
   * The secret an outside service sends to fire a job by name through
   * `POST /api/hooks/<name>`. Its own secret, not the dashboard token: a
   * hook caller can start a job the owner wrote and nothing else. Unset
   * means there are no hooks.
   */
  hookSecret?: string;
  /** Bind policy hint for logs; enforcement is host-level. Default loopback. */
  host?: string;
  /** Hosted-mode metadata for /api/health and /api/status (daemon). */
  meta?: DaemonMeta;
  /**
   * The dotenv file this host reads, so the settings page can write it. Must
   * be outside the workspace; writing is refused otherwise.
   */
  envPath?: string;
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
const HOOKS_PREFIX = "/api/hooks/";
const CALLER_PREFIX = "/api/caller/";

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

  /*
   * An inbound hook: an outside service firing a job by name.
   *
   * Ahead of the dashboard token on purpose. The caller holds a secret made
   * for this and nothing else; it opens no read and no other route. The
   * body is ignored, so a caller can start a job the owner already wrote
   * but cannot put words in it. The reply comes before the run: a webhook
   * sender gives up in seconds, a self-prompt can take minutes, and the
   * run reports to health the way a scheduled one does.
   */
  if (path.startsWith(HOOKS_PREFIX)) {
    if (method !== "POST") return { status: 405, body: { error: "POST only" } };
    if (!options.hookSecret) {
      return { status: 403, body: { error: "hooks are off: set KOS_HOOK_SECRET" } };
    }
    if (!authorized(req, options.hookSecret)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    const name = decodeURIComponent(path.slice(HOOKS_PREFIX.length));
    const job = kernel.crons.list().find((c) => c.name === name);
    if (!job) return { status: 404, body: { error: "no such job" } };
    if (!job.enabled) return { status: 409, body: { error: `${job.name} is paused` } };
    void kernel.fireCron(job.id).catch((err: unknown) => {
      console.error(`hook ${job.name}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return { status: 202, body: { accepted: job.name } };
  }

  /*
   * A caller: another program with its own token and its own scope.
   *
   * Ahead of the dashboard token, like a hook: the token opens these
   * routes and nothing else. What it reads of the owner's memory is the
   * global claims whose tags it was granted, and its own scope; what it
   * writes lands in its own scope unless the grant says global.
   */
  if (path.startsWith(CALLER_PREFIX)) {
    const bearer = bearerOf(req);
    const caller = bearer ? kernel.callers.authenticate(bearer) : undefined;
    if (!caller) return { status: 401, body: { error: "unauthorized" } };
    const owner = kernel.profile.ownerId;
    const mine = callerScope(caller.name);
    const visible = (f: Fact): boolean => f.scope === mine || (f.scope === GLOBAL_SCOPE && mayRead(caller, f.tags));
    const sub = path.slice(CALLER_PREFIX.length);

    if (method === "GET" && sub === "memory") {
      const query = queryParams(req.url).get("query") ?? "";
      const limit = clampLimit(queryParams(req.url).get("limit"), 50);
      const claims = (query ? kernel.facts.search(owner, query, 200, { scopes: [GLOBAL_SCOPE, mine] }) : kernel.facts.all(owner, [GLOBAL_SCOPE, mine]))
        .filter(visible)
        .slice(0, limit);
      return ok({ caller: caller.name, scope: mine, claims });
    }
    if (method === "POST" && sub === "memory") {
      const key = typeof body.key === "string" ? body.key.trim() : "";
      const value = typeof body.value === "string" ? body.value : "";
      if (!key || value === "") return { status: 400, body: { error: "key and value required" } };
      const wantsGlobal = body.scope === "global";
      if (wantsGlobal && !caller.writeGlobal) return { status: 403, body: { error: "this caller may not write global memory" } };
      const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined;
      const written = kernel.facts.upsert(
        owner,
        { key, value, kind: body.kind === "preference" ? "preference" : "fact", scope: wantsGlobal ? GLOBAL_SCOPE : mine, trust: "external", ...(tags ? { tags } : {}) },
        `caller:${caller.name}`,
      );
      return ok(written);
    }
    if (method === "POST" && sub === "memory/delete") {
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key) return { status: 400, body: { error: "key required" } };
      // Only its own scope: a caller cannot forget what the owner knows.
      const gone = kernel.facts.delete(owner, key, mine);
      return ok({ key, removed: gone.removed });
    }
    if (method === "GET" && sub === "memory/trace") {
      const key = queryParams(req.url).get("key") ?? "";
      const claim = kernel.facts.get(owner, key, mine) ?? kernel.facts.get(owner, key, GLOBAL_SCOPE);
      if (!claim || !visible(claim)) return { status: 404, body: { error: "not known to you" } };
      const trace = kernel.facts.trace(claim.id)!;
      return ok({ key, claim, before: trace.before.filter(visible), revisions: trace.revisions });
    }
    if (method === "POST" && sub === "ingest") {
      // The caller's own conversation, into the log, as the outside world's words.
      const events = Array.isArray(body.events) ? (body.events as unknown[]) : [];
      const ids: number[] = [];
      for (const e of events.slice(0, 200)) {
        if (typeof e !== "object" || e === null) continue;
        const ev = e as { role?: unknown; text?: unknown; conversation?: unknown };
        const text = typeof ev.text === "string" ? ev.text.trim().slice(0, 4000) : "";
        if (!text) continue;
        ids.push(kernel.events.append({
          userId: owner,
          role: ev.role === "agent" ? "agent" : "owner",
          text,
          caller: caller.name,
          trust: "external",
          conversationId: typeof ev.conversation === "string" ? `caller:${caller.name}:${ev.conversation}` : null,
        }));
      }
      return ok({ ingested: ids.length });
    }
    return { status: 404, body: { error: "not found" } };
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
      hooks: options.hookSecret !== undefined,
      pid: options.meta?.pid ?? process.pid,
      workspace: options.meta?.workspace ?? kernel.workspace.root,
      orchestratorId: orchestratorId(kernel.profile.ownerId),
      routes: kernel.routes() ?? null,
      // Carried on the status the dashboard already polls, so an unattended
      // failure is visible on the next open rather than only in a message the
      // owner may have missed.
      unhealthy: kernel.health.failing().length,
    });
  }

  /**
   * Is KOS well? Failing jobs with how long and how often, plus the recent
   * failure rate. Its own endpoint because the detail is more than a status
   * poll should carry.
   */
  if (method === "GET" && path === "/api/health/report") {
    return ok(kernel.health.report());
  }

  /**
   * Put KOS on a failure. Named by what failed rather than by an id the
   * caller had to look up, so History can hand over exactly what it is
   * already showing in the row.
   */
  if (method === "POST" && path === "/api/fix") {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const error = typeof body.error === "string" ? body.error.trim() : "";
    if (!label || !error) {
      return { status: 400, body: { error: "label and error required" } };
    }
    if (kernel.killSwitch.halted) {
      return { status: 409, body: { error: "KOS is halted" } };
    }
    const started = await kernel.startFix({
      label: label.slice(0, 200),
      error,
      what: typeof body.what === "string" ? body.what.slice(0, 40) : "job",
      ...(typeof body.ref === "string" ? { ref: body.ref.slice(0, 60) } : {}),
    });
    return ok(started);
  }

  /**
   * How KOS behaves unattended. One document rather than a setting per
   * endpoint: they are read together, edited together, and a half-saved set
   * of limits is not a state worth being able to reach.
   */
  if (method === "GET" && path === "/api/settings/behaviour") {
    return ok({
      behaviour: kernel.behaviour(),
      defaults: BEHAVIOUR_DEFAULTS,
      limits: BEHAVIOUR_LIMITS,
    });
  }

  if (method === "POST" && path === "/api/settings/behaviour") {
    // Parsed, not trusted: these govern spend and runaway loops, so every
    // number is clamped to a range before it is stored.
    const behaviour = parseBehaviour(body.behaviour ?? body);
    kernel.settings.set(BEHAVIOUR_KEY, behaviour);
    return ok({ behaviour });
  }

  /** Stop reporting a job as broken, for one the owner has dealt with. */
  if (method === "POST" && path === "/api/health/dismiss") {
    const key = typeof body?.key === "string" ? body.key : null;
    if (!key) return { status: 400, body: { error: "key required" } };
    kernel.health.forget(key);
    return ok({ dismissed: key });
  }

  /**
   * Run a job now. "Does this actually work" was otherwise answerable only by
   * waiting for the schedule, which for a nightly job is a day per attempt.
   */
  if (method === "POST" && path === "/api/crons/run") {
    const id = Number(body?.id);
    if (!Number.isInteger(id)) {
      return { status: 400, body: { error: "id required" } };
    }
    if (!kernel.crons.get(id)) {
      return { status: 404, body: { error: "no such job" } };
    }
    return ok(await kernel.fireCron(id));
  }

  if (method === "GET" && path === "/api/settings/models") {
    return ok({
      routes: kernel.routes() ?? null,
      saved: kernel.settings.get(MODEL_SETTINGS_KEY) ?? {},
      efforts: EFFORTS,
      providers: kernel.providerNames(),
      custom: kernel.customEndpoint() ?? null,
    });
  }

  /** The owner's own endpoint: an OpenAI-compatible URL, a key under KOS_SECRET_CUSTOM if it wants one. */
  if (method === "POST" && path === "/api/settings/models/custom") {
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) return { status: 400, body: { error: "baseUrl must start with http:// or https://" } };
    const saved = kernel.setCustomEndpoint(baseUrl);
    return ok({ custom: saved ?? null, providers: kernel.providerNames() });
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
    /*
     * Tool calls only. This also returned the same run rows as /api/runs,
     * which the dashboard fetches separately -- so every poll ran the runs
     * query twice and serialized a copy the only caller dropped on arrival.
     */
    const limit = clampLimit(queryParams(req.url).get("limit"), 100);
    /*
     * Without the output of calls that worked.
     *
     * A tool result is the bulk of this list -- 183KB of a 324KB response on
     * a real workspace -- and the list never shows one. Only a failure needs
     * its text here, to seed the fix without a second request; the rest is
     * fetched when a reader actually opens a call.
     */
    const tools = kernel.audit.recent(limit).map((t) =>
      t.isError ? t : { ...t, result: "" },
    );
    return ok({ tools });
  }

  if (method === "GET" && path === "/api/activity/call") {
    const id = Number(queryParams(req.url).get("id"));
    if (!Number.isInteger(id)) {
      return { status: 400, body: { error: "id required" } };
    }
    const call = kernel.audit.get(id);
    if (!call) return { status: 404, body: { error: "no such call" } };
    return ok(call);
  }

  if (method === "POST" && path === "/api/projects/chat") {
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) return { status: 400, body: { error: "slug required" } };
    try {
      return ok(kernel.ensureProjectConversation(slug));
    } catch (err) {
      return { status: 404, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  if (method === "GET" && path === "/api/permissions") {
    return ok({ rules: kernel.permissions.list() });
  }

  if (method === "POST" && path === "/api/permissions/revoke") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    return kernel.permissions.revoke(id) ? ok({ id, revoked: true }) : { status: 404, body: { error: `no rule #${id}` } };
  }

  if (method === "GET" && path === "/api/skills") {
    const { skills, invalid } = readSkills(kernel.workspace);
    const off = new Set(parseSkillSettings(kernel.settings.get(SKILLS_KEY)).disabled);
    return ok({
      skills: skills.map((s) => ({ ...s.manifest, file: s.file, enabled: !off.has(s.manifest.name) })),
      invalid,
    });
  }

  if (method === "POST" && path === "/api/skills/enable") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const enabled = body.enabled === true;
    const known = readSkills(kernel.workspace).skills.some((s) => s.manifest.name === name);
    if (!known) return { status: 404, body: { error: `no skill named ${name}` } };
    const next = withSkillEnabled(parseSkillSettings(kernel.settings.get(SKILLS_KEY)), name, enabled);
    kernel.settings.set(SKILLS_KEY, next);
    return ok({ name, enabled });
  }

  if (method === "GET" && path === "/api/modules") {
    const { modules, invalid } = readWorkspaceModules(kernel.workspace);
    const on = new Set(parseModuleSettings(kernel.settings.get(MODULES_KEY)).enabled);
    const status = kernel.mcp.status();
    return ok({
      modules: modules.map((m) => ({
        ...m.manifest,
        dir: m.dir,
        enabled: on.has(m.manifest.name),
        ...(status[m.manifest.name] ?? {}),
      })),
      invalid,
    });
  }

  /*
   * Switching a module on brings its server up now and registers its
   * tools; off takes them back. The reply says whether it came up, so the
   * page can show "not connected" instead of a lying toggle.
   */
  if (method === "POST" && path === "/api/modules/enable") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const enabled = body.enabled === true;
    const known = readWorkspaceModules(kernel.workspace).modules.some((m) => m.manifest.name === name);
    if (!known) return { status: 404, body: { error: `no module named ${name}` } };
    kernel.settings.set(MODULES_KEY, withModuleEnabled(parseModuleSettings(kernel.settings.get(MODULES_KEY)), name, enabled));
    const status = await kernel.mcp.reload();
    return ok({ name, enabled, ...(status[name] ?? {}) });
  }

  if (method === "GET" && path === "/api/crons") {
    /*
     * With where each job's runs live, and whether one is happening.
     *
     * A job used to be a row and a schedule: whether it was running right
     * now, and what it did last time, were not answerable from here at all.
     */
    const threads = new Map(
      kernel.conversations
        .list(kernel.profile.ownerId, { includeArchived: true })
        .map((c) => [c.id, c]),
    );
    const busyNow = new Set(kernel.busyConversations());
    return ok(
      kernel.crons.list().map((job) => {
        const thread = threads.get(cronSessionId(job.id));
        /*
         * lastRunAt comes from the job, not its conversation.
         *
         * It used to be the thread's updated_at, which moves when the thread
         * is touched and does not exist at all for a job that has no thread.
         * The nightly backup had run since July and reported "never".
         */
        return {
          ...job,
          ...(thread
            ? { conversationId: thread.id, running: busyNow.has(thread.id) }
            : {}),
        };
      }),
    );
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
    if (removed) {
      /*
       * The thread goes with the job.
       *
       * It exists to hold that job's runs, and a schedule thread cannot be
       * renamed or deleted by hand, so left behind it was an orphan the owner
       * could neither reach from the schedule list nor get rid of. The
       * confirmation says the runs go too.
       */
      kernel.sessions.clear(cronSessionId(id));
      kernel.conversations.remove(cronSessionId(id));
      kernel.reloadCron();
    }
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
    return ok(await kernel.approve(id, undefined, { remember: body.remember === true }));
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
      if (sessionId.startsWith("project:")) {
        return ok(
          await kernel.handleProjectTurn(sessionId.slice("project:".length), text, {
            channel: "dashboard",
            attachments,
          }),
        );
      }
      if (sessionId === orchestratorId(kernel.profile.ownerId)) {
        return ok(
          await kernel.handleOrchestratorTurn(text, {
            channel: "dashboard",
            attachments,
          }),
        );
      }
      // A slash command is bookkeeping, not something to ask a model about.
      const command = await kernel.runCommandIn(sessionId, userId, text);
      if (command) return ok(command);
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

  if (method === "GET" && path === "/api/settings") {
    // Values are never sent back, only whether one is set and its last four
    // characters, which is enough to tell two keys apart and no use to anyone.
    const envPath = options.envPath;
    const secrets = maskedSecrets();
    const settings: Record<string, { label: string; hint: string; value: string }> = {};
    for (const [key, meta] of Object.entries(WRITABLE_SETTINGS)) {
      settings[key] = { ...meta, value: process.env[key] ?? "" };
    }
    return ok({
      workspace: kernel.workspace.root,
      profile: {
        name: kernel.profile.name,
        timezone: kernel.profile.timezone,
        ownerId: kernel.profile.ownerId,
      },
      retention: kernel.sessions.retention(),
      buildModel:
        kernel.settings.get<{ buildModel?: string }>(BUILD_SETTINGS_KEY)?.buildModel ??
        null,
      retentionDefaults: RETENTION_DEFAULTS,
      halted: kernel.killSwitch.halted,
      envPath: envPath ?? null,
      // Said plainly, because "why will it not save" is otherwise a mystery
      // whose answer is in a comment in another file.
      envWritable:
        envPath !== undefined && !isInside(kernel.workspace.root, envPath),
      secrets,
      settings,
      sitesUrl: sitesBaseUrl() ?? null,
      routes: kernel.routes() ?? null,
    });
  }

  if (method === "POST" && path === "/api/settings") {
    const envPath = options.envPath;
    if (!envPath) {
      return {
        status: 400,
        body: { error: "this host was started without an env file to write to" },
      };
    }
    const raw = body.values;
    if (typeof raw !== "object" || raw === null) {
      return { status: 400, body: { error: "values must be an object" } };
    }
    const values: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isWritableKey(key)) continue;
      values[key] = typeof value === "string" ? value : null;
    }

    try {
      const result = writeEnvFile(envPath, kernel.workspace.root, values);
      // Applied to this process too, so a key saved here works on the next
      // turn rather than on the next restart.
      for (const [key, value] of Object.entries(values)) {
        // Aliases as well: leaving DISCORD_TOKEN set in this process would
        // keep Discord running after the owner cleared the field for it.
        for (const name of namesFor(key)) delete process.env[name];
        if (value !== null && value !== "") process.env[key] = value;
      }
      kernel.reloadSecrets();
      return ok({ ...result, secrets: maskedSecrets() });
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "POST" && path === "/api/settings/profile") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
    if (!name) return { status: 400, body: { error: "name required" } };
    // Checked against the runtime rather than a list: a timezone this machine
    // does not know would silently make every schedule fire at the wrong hour.
    if (timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
      } catch {
        return {
          status: 400,
          body: { error: `not a timezone this machine knows: ${timezone}` },
        };
      }
    }
    const next = {
      ...kernel.profile,
      name,
      ...(timezone ? { timezone } : {}),
    };
    saveProfile(kernel.workspace, next);
    Object.assign(kernel.profile, next);
    return ok({ profile: next });
  }

  if (method === "POST" && path === "/api/settings/builds") {
    const raw = typeof body.buildModel === "string" ? body.buildModel.trim() : "";
    // Empty means "whatever the CLI defaults to", which is a real choice and
    // the one a workspace starts on.
    kernel.settings.set(BUILD_SETTINGS_KEY, raw ? { buildModel: raw } : {});
    return ok({ buildModel: raw || null });
  }

  if (method === "POST" && path === "/api/settings/retention") {
    const accepted: Record<string, number> = {};
    const rejected: string[] = [];
    for (const key of ["maxChars", "maxToolResultChars", "maxExchanges"]) {
      const raw = (body as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      const value = Number(raw);
      // Zero is off for that budget, which the owner may genuinely want.
      // Negative is not a smaller budget, it is a typo.
      if (Number.isFinite(value) && value >= 0) accepted[key] = Math.floor(value);
      else rejected.push(key);
    }
    // Off is a switch, not a budget, so it is read separately.
    const auto = (body as Record<string, unknown>)["autoTrim"];
    const accepted2: Record<string, number | boolean> = { ...accepted };
    if (typeof auto === "boolean") accepted2["autoTrim"] = auto;

    if (rejected.length > 0) {
      return {
        status: 400,
        body: {
          error: `must be a number, 0 for no limit: ${rejected.join(", ")}`,
        },
      };
    }
    // Merged, not replaced. Storing only what this request carried wiped the
    // settings the owner had already saved: a request with nothing valid in
    // it reset everything to the defaults on the next start.
    const merged = {
      ...(kernel.settings.get<Record<string, number | boolean>>(RETENTION_KEY) ?? {}),
      ...accepted2,
    };
    kernel.settings.set(RETENTION_KEY, merged);
    kernel.sessions.configure(merged);
    return ok({ retention: kernel.sessions.retention() });
  }

  if (method === "POST" && path === "/api/pending/edit") {
    const id = Number(body.id);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    if (!text) return { status: 400, body: { error: "text required" } };
    // Only while it is still waiting. Once the turn has started the question
    // has been asked, and rewriting it would change the record of something
    // already answered.
    if (!kernel.pending.edit(id, text)) {
      return {
        status: 409,
        body: { error: "that message has already started running" },
      };
    }
    return ok({ pending: kernel.pending.forConversation(String(body.conversationId ?? "")) });
  }

  if (method === "POST" && path === "/api/pending/delete") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    if (!kernel.pending.remove(id)) {
      return {
        status: 409,
        body: { error: "that message has already started running" },
      };
    }
    return ok({ pending: kernel.pending.forConversation(String(body.conversationId ?? "")) });
  }

  if (method === "POST" && path === "/api/pending/fork") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    const waiting = kernel.pending.get(id);
    if (!waiting) {
      return {
        status: 409,
        body: { error: "that message has already started running" },
      };
    }
    try {
      // The conversation as it stands, plus this message, in a thread of its
      // own. The original keeps running whatever else is queued behind it.
      const forked = await kernel.forkPending(waiting);
      return ok({ conversationId: forked });
    } catch (err) {
      return {
        status: 400,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === "GET" && path === "/api/agents") {
    // What is running inside the workspace right now. Builds are the only kind
    // so far; the shape leaves room for others without the page changing.
    //
    // The list carries a short tail per build; the full log is fetched for the
    // one being read, so a page listing ten builds does not ship ten
    // transcripts to draw ten summaries.
    return ok({
      builds: kernel.builds.list().map((b) => ({ ...b, events: b.events.slice(-12) })),
    });
  }

  if (method === "GET" && path.startsWith("/api/agents/")) {
    const id = Number(path.slice("/api/agents/".length));
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    const build = kernel.builds.get(id);
    if (!build) return { status: 404, body: { error: "no such build" } };
    return ok({
      build,
      // Its own requests and no other build's: listing every build.* awaiting
      // a decision invites approving one build's shell command from a
      // different build's log.
      approvals: kernel.approvals
        .pending()
        .filter((a) => build.waitingOn.includes(a.id)),
    });
  }

  /**
   * Start a coding agent from the Agents page.
   *
   * builds.run is a risky tool because the agent normally decides to reach
   * for it and the owner should get a say. Here the owner is the one asking,
   * with the folder and the task in front of them, which is the same decision
   * the approval would have asked for. What the sub-agent then does is
   * unchanged: every shell command and everything outside its folder still
   * comes back for approval.
   */
  if (method === "POST" && path === "/api/agents/start") {
    const dir = typeof body.dir === "string" ? body.dir.trim() : "";
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!dir || !task) {
      return { status: 400, body: { error: "dir and task required" } };
    }
    if (kernel.killSwitch.halted) {
      return { status: 409, body: { error: "KOS is halted" } };
    }
    // Not awaited: a build runs for minutes and the page watches the list.
    void kernel.registry
      .execute("builds.run", { dir, task })
      .catch(() => undefined);
    return ok({ started: true, dir });
  }

  /**
   * Say something to an agent that has finished.
   *
   * A finished build's process is gone, so this starts another one in the
   * same folder resuming the same SDK session: it keeps what it already
   * worked out rather than reading the folder again from nothing. Without
   * this, a build that stopped one step short was a dead end.
   */
  if (method === "POST" && path === "/api/agents/wake") {
    const id = Number(body.id);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const build = Number.isInteger(id) ? kernel.builds.get(id) : undefined;
    if (!build || !text) {
      return { status: 400, body: { error: "id and text required" } };
    }
    if (build.status === "running" || build.status === "waiting") {
      return { status: 409, body: { error: "it is still running" } };
    }
    if (kernel.killSwitch.halted) {
      return { status: 409, body: { error: "KOS is halted" } };
    }
    void kernel.registry
      .execute("builds.run", {
        dir: build.dir,
        task: text,
        ...(build.sessionId ? { resume: build.sessionId } : {}),
      })
      .catch(() => undefined);
    return ok({ woke: true, dir: build.dir, resumed: Boolean(build.sessionId) });
  }

  /** Remove a finished agent from the list. */
  if (method === "POST" && path === "/api/agents/forget") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) {
      return { status: 400, body: { error: "id required" } };
    }
    if (!kernel.builds.forget(id)) {
      return { status: 409, body: { error: "still running" } };
    }
    return ok({ builds: kernel.builds.list() });
  }

  if (method === "POST" && path === "/api/agents/stop") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    if (!kernel.builds.stop(id)) {
      // The ordinary answer for one that finished while it was being read
      // about, so it is not an error.
      return ok({ stopped: false, builds: kernel.builds.list() });
    }
    return ok({ stopped: true, builds: kernel.builds.list() });
  }

  if (method === "POST" && path === "/api/agents/send") {
    const id = Number(body.id);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    if (!text) return { status: 400, body: { error: "text required" } };
    if (!kernel.builds.send(id, text)) {
      return { status: 409, body: { error: "that build is no longer running" } };
    }
    return ok({ sent: true, builds: kernel.builds.list() });
  }

  if (method === "POST" && path === "/api/agents/interrupt") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return { status: 400, body: { error: "id required" } };
    if (!(await kernel.builds.interrupt(id))) {
      return { status: 409, body: { error: "that build is no longer running" } };
    }
    return ok({ interrupted: true, builds: kernel.builds.list() });
  }

  if (method === "GET" && path === "/api/home") {
    return ok({
      layout: parseHomeLayout(kernel.settings.get(HOME_LAYOUT_KEY)),
      // Everything the panels draw from, in one round trip: home is the first
      // thing loaded and eight separate requests to render it is eight chances
      // to see it assemble itself.
      approvals: kernel.approvals.pending(),
      agents: kernel.builds.list().slice(0, 8),
      failures: kernel.runs.failures(10),
      health: kernel.health.report(),
      activity: kernel.audit.recent(20),
      projects: kernel.manifest.list(),
      chats: kernel.conversations.list(kernel.profile.ownerId).slice(0, 10),
      crons: kernel.crons.list(),
      spend: {
        models: kernel.spend.byModel(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    });
  }

  if (method === "POST" && path === "/api/home") {
    // Parsed rather than trusted: this is a layout the owner edits and KOS may
    // later write, and a bad one should degrade to the default rather than
    // leave them with no home page.
    const layout = parseHomeLayout(body.layout);
    kernel.settings.set(HOME_LAYOUT_KEY, layout);
    return ok({ layout });
  }

  if (method === "GET" && path === "/api/spend") {
    const days = clampLimit(queryParams(req.url).get("days"), 30);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const rates = parseRates(kernel.settings.get(RATES_KEY));
    const models = kernel.spend.byModel(since).map((m) => ({
      ...m,
      // Undefined rather than zero when no rate is set: a model the owner has
      // not priced has an unknown cost, which is not the same as a free one.
      cost: costOf(m, rates),
    }));
    return ok({
      days,
      models,
      byDay: kernel.spend.byDay(since),
      // Per model per day, so a total in the table can be opened up into the
      // days that made it. Costed here rather than in the browser: the rate
      // lookup has a fallback in it and two copies of that rule would drift.
      byModelDay: kernel.spend
        .byModelDay(since)
        .map((d) => ({ ...d, cost: costOf(d, rates) })),
      rates,
    });
  }

  if (method === "POST" && path === "/api/spend/rates") {
    const rates = parseRates(body.rates);
    kernel.settings.set(RATES_KEY, rates);
    return ok({ rates });
  }

  if (method === "GET" && path === "/api/context") {
    // What the last turn actually put in front of the model, as the provider
    // counted it, plus what this conversation has cost in total.
    const id = queryParams(req.url).get("conversationId") ?? "";
    if (!id) return { status: 400, body: { error: "conversationId required" } };
    const last = kernel.spend.lastContext(id);
    const retained = kernel.sessions.get(id);
    const retention = kernel.sessions.retention();
    // What KOS keeps is knowable for every model, and it is usually what
    // binds first: history is trimmed at this budget long before a modern
    // context window is anywhere near full. A percentage of the model window
    // alone said 2% while the conversation was about to start losing its
    // oldest turns.
    const historyChars = JSON.stringify(retained).length;
    const exchanges = retained.filter((m) => m.role === "user").length;
    return ok({
      conversationId: id,
      history: {
        historyChars,
        maxChars: retention.maxChars,
        exchanges,
        maxExchanges: retention.maxExchanges,
      },
      ...(last ? { last } : {}),
      total: kernel.spend.forConversation(id),
      window: last
        ? windowFor(
            last.provider,
            last.model,
            parseRates(kernel.settings.get(RATES_KEY)),
            contextWindowFor,
          )
        : undefined,
    });
  }

  if (method === "GET" && path.startsWith("/api/projects/") && path.endsWith("/detail")) {
    const slug = decodeURIComponent(
      path.slice("/api/projects/".length).replace(/\/detail$/, ""),
    );
    const project = kernel.manifest.list().find((p) => p.slug === slug);
    if (!project) return { status: 404, body: { error: "project not found" } };

    // A project's tables are namespaced with its slug, so they can be found
    // without a registry of them. Counted here rather than guessed at: "how
    // much is actually in this thing" is the first question about a tracker.
    const tables: { name: string; rows: number; columns: number }[] = [];
    try {
      // Filtered here rather than with LIKE: the separator is an underscore,
      // which LIKE treats as a wildcard, so the pattern needed an ESCAPE
      // clause to mean what it looked like it meant and silently matched
      // nothing without one.
      const prefix = `${slug}_`;
      const rows = (
        kernel.workspace.db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
          .all() as { name: string }[]
      ).filter((r) => r.name.startsWith(prefix));
      for (const row of rows) {
        try {
          const count = kernel.workspace.db
            .prepare(`SELECT COUNT(*) AS n FROM "${row.name}"`)
            .get() as { n: number };
          const cols = kernel.workspace.db
            .prepare(`PRAGMA table_info("${row.name}")`)
            .all() as unknown[];
          tables.push({
            name: row.name.slice(slug.length + 1),
            rows: count.n,
            columns: cols.length,
          });
        } catch {
          // A table that cannot be counted is still worth naming.
          tables.push({ name: row.name.slice(slug.length + 1), rows: -1, columns: 0 });
        }
      }
    } catch {
      // No tables yet is the normal state of a new project, not an error.
    }

    return ok({
      project,
      tables,
      pages: kernel.pages.list().filter((pg) => pg.projectSlug === slug),
      crons: kernel.crons.list().filter((c) => c.projectSlug === slug),
      sites: listSitesFor(kernel.workspace, slug),
      sitesBase: sitesBaseUrl() ?? null,
      // What has been done to its shape, newest first: a schema is a thing
      // that grows, and the history says how it got here.
      migrations: kernel.migrator.history(slug).slice(-10).reverse(),
      // What has been done to it lately. The drawer could say what a project
      // contained and nothing about what had happened to it, which is the
      // question you open it to ask when a tracker looks wrong.
      activity: kernel.audit.touching(slug, 12),
      folder: `${PROJECTS_DIR}/${slug}`,
    });
  }

  if (method === "GET" && path === "/api/sites") {
    // The base URL is where the site server is bound, which is a different
    // origin from this one on purpose. The dashboard links out to it rather
    // than embedding it.
    return ok({ base: sitesBaseUrl() ?? null, sites: listSites(kernel.workspace) });
  }

  if (method === "GET" && path === "/api/file/raw") {
    // Image bytes for the browser to draw. The allow-list and the type live in
    // readImage; nosniff and a sandboxing policy are here so that even a file
    // that somehow reached this point mislabelled cannot become a document on
    // the dashboard's own origin.
    const target = queryParams(req.url).get("path") ?? "";
    if (!target) return { status: 400, body: { error: "path required" } };
    try {
      const raw = readImage(kernel.workspace, target);
      return {
        status: 200,
        body: raw.bytes,
        headers: {
          "content-type": raw.contentType,
          "content-length": String(raw.bytes.byteLength),
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "content-disposition": "inline",
        },
      };
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
    // A folder with its own git repo is not covered by this, and silently
    // omitting things from a backup is how a backup lies to you.
    return ok({ sha, excluded: await kernel.backup.excluded() });
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

  /** Folders in the workspace, for anything that asks the owner to name one. */
  if (method === "GET" && path === "/api/folders") {
    return ok({ folders: walkFolders(kernel.workspace) });
  }

  if (method === "GET" && path === "/api/mentions") {
    const params = queryParams(req.url);
    const q = params.get("q") ?? "";
    const kind = params.get("kind");
    const kinds = ["project", "page", "file", "schedule", "chat", "site", "agent"];
    // The palette and the @ menu ask the same question of the same index, so
    // a thing reachable by one is reachable by the other.
    const limit = clampLimit(params.get("limit"), 12);
    return ok({
      mentions: findMentions(
        {
          projects: kernel.manifest.list(),
          pages: kernel.pages.list(),
          crons: kernel.crons.list(),
          workspace: kernel.workspace,
          chats: kernel.conversations
            .list(kernel.profile.ownerId)
            .map((c) => ({ id: c.id, title: c.title })),
          sites: listSites(kernel.workspace),
          agents: kernel.builds
            .list()
            .map((b) => ({ id: b.id, dir: b.dir, status: b.status })),
        },
        q,
        limit,
        kind && kinds.includes(kind) ? (kind as MentionKind) : undefined,
      ),
      commands: CHAT_COMMANDS,
    });
  }

  if (method === "GET" && path === "/api/conversations") {
    const includeArchived = queryParams(req.url).get("archived") === "1";
    // The orchestrator and the surface streams are included and labelled
    // rather than filtered out: the owner should be able to open the thread
    // that routes their work, and the one their phone talks in. The
    // agent-facing chats.list still hides them.
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
          // What a thread is, so the list can group them and refuse to
          // rename what is not the owner's to rename.
          kind: conversationKind(c, kernel.profile.ownerId),
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
      // Sent but not yet run. Shown after the transcript because that is where
      // they will land, and separately because they have not happened yet.
      pending: kernel.pending.forConversation(id).map((m) => ({
        id: m.id,
        text: m.text,
        attachments: m.attachments.map((a) => ({ name: a.name })),
      })),
    });
  }

  if (method === "POST" && path === "/api/conversations/new") {
    const title = typeof body.title === "string" ? body.title : undefined;
    const projectSlug = typeof body.projectSlug === "string" && body.projectSlug.trim() ? body.projectSlug.trim() : undefined;
    const created = kernel.conversations.create({
      userId: kernel.profile.ownerId,
      channel: "dashboard",
      ...(title ? { title } : {}),
      ...(projectSlug ? { projectSlug } : {}),
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
    const fixed = refuseFixed(kernel, id, "renamed");
    if (fixed) return fixed;
    const renamed = kernel.conversations.rename(id, title);
    if (!renamed) return { status: 404, body: { error: "conversation not found" } };
    return ok(renamed);
  }

  if (method === "POST" && path === "/api/conversations/archive") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    const fixed = refuseFixed(kernel, id, "archived");
    if (fixed) return fixed;
    const updated = kernel.conversations.setArchived(id, body.archived !== false);
    if (!updated) return { status: 404, body: { error: "conversation not found" } };
    return ok(updated);
  }

  if (method === "POST" && path === "/api/conversations/delete") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return { status: 400, body: { error: "id required" } };
    const fixed = refuseFixed(kernel, id, "deleted");
    if (fixed) return fixed;
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
    const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "global";
    return ok(
      kernel.facts.upsert(
        kernel.profile.ownerId,
        {
          key,
          value,
          kind,
          scope,
          ...(tags ? { tags } : {}),
          ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        },
        "dashboard",
      ),
    );
  }

  if (method === "POST" && path === "/api/memory/delete") {
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) return { status: 400, body: { error: "key required" } };
    const gone = kernel.facts.delete(kernel.profile.ownerId, key);
    if (gone.evidence.length) kernel.events.redact(gone.evidence);
    return ok({ key, removed: gone.removed, redactedEvents: gone.evidence.length });
  }

  /** What the extractor has not read yet, and whether it is on. */
  if (method === "GET" && path === "/api/memory/extract") {
    const how = kernel.behaviour();
    return ok({
      enabled: how.memoryExtraction,
      everyChars: how.extractEveryChars,
      pending: kernel.extractor.pending(),
      lastEventId: kernel.extractor.state().lastEventId,
      running: kernel.extractor.busy,
    });
  }

  /** Read everything new now, whatever the toggle says: the owner asked. */
  if (method === "POST" && path === "/api/memory/extract") {
    if (kernel.extractor.busy) return { status: 409, body: { error: "the extractor is already running" } };
    const report = await kernel.extractMemory();
    return ok({ ...report, claims: report.claims.map((c) => ({ key: c.key, value: c.value, scope: c.scope, trust: c.trust, replaced: c.supersedes !== null })) });
  }

  /** Callers: the owner's grants to other programs. The token is in the create reply and nowhere else. */
  if (method === "GET" && path === "/api/callers") {
    return ok({ callers: kernel.callers.list() });
  }
  if (method === "POST" && path === "/api/callers") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const readTags = Array.isArray(body.readTags) ? (body.readTags as unknown[]).filter((t): t is string => typeof t === "string") : [];
    try {
      const made = kernel.callers.create(name, { readTags, writeGlobal: body.writeGlobal === true });
      return ok(made);
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
  if (method === "POST" && path === "/api/callers/update") {
    const id = Number(body.id);
    const readTags = Array.isArray(body.readTags) ? (body.readTags as unknown[]).filter((t): t is string => typeof t === "string") : undefined;
    const updated = kernel.callers.update(id, { ...(readTags ? { readTags } : {}), ...(typeof body.writeGlobal === "boolean" ? { writeGlobal: body.writeGlobal } : {}) });
    if (!updated) return { status: 404, body: { error: "no such caller" } };
    return ok(updated);
  }
  if (method === "POST" && path === "/api/callers/revoke") {
    const id = Number(body.id);
    return ok({ id, revoked: kernel.callers.revoke(id) });
  }

  /** What the dream job left for the owner: open items first, then the recent resolved ones. */
  if (method === "GET" && path === "/api/memory/review") {
    return ok({ pending: kernel.review.pending(), recent: kernel.review.recent(20), pages: listPages(kernel.workspace) });
  }

  if (method === "POST" && path === "/api/memory/review/resolve") {
    const id = Number(body.id);
    const resolution = typeof body.resolution === "string" ? body.resolution.trim() : "";
    if (!Number.isInteger(id) || !resolution) return { status: 400, body: { error: "id and resolution required" } };
    const item = kernel.review.resolve(id, resolution);
    if (!item) return { status: 404, body: { error: "no such item" } };
    return ok(item);
  }

  if (method === "GET" && path === "/api/memory/page") {
    const name = queryParams(req.url).get("name") ?? "";
    const text = name ? readPage(kernel.workspace, name) : undefined;
    if (text === undefined) return { status: 404, body: { error: "no such page" } };
    return ok({ name, markdown: text });
  }

  /** Where a belief came from, and what it replaced. */
  if (method === "GET" && path === "/api/memory/trace") {
    const key = queryParams(req.url).get("key") ?? "";
    if (!key) return { status: 400, body: { error: "key required" } };
    const claim = kernel.facts.get(kernel.profile.ownerId, key);
    const history = kernel.facts.history(kernel.profile.ownerId, key);
    if (!claim) return ok({ key, claim: null, history });
    const trace = kernel.facts.trace(claim.id)!;
    return ok({
      key,
      claim,
      before: trace.before,
      revisions: trace.revisions,
      evidence: trace.evidence.map((id) => kernel.events.get(id)).filter((e) => e !== undefined),
    });
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

/**
 * Every writable secret, masked, as the settings page shows them.
 *
 * `storedAs` names where the value actually is when that is not the canonical
 * name. The page said "not set" for a working Discord token because it looked
 * only at KOS_SECRET_DISCORD while the token was under DISCORD_TOKEN.
 */
function maskedSecrets(): Record<
  string,
  { label: string; hint: string; masked: string | null; storedAs?: string }
> {
  const out: Record<
    string,
    { label: string; hint: string; masked: string | null; storedAs?: string }
  > = {};
  for (const [key, meta] of Object.entries(WRITABLE_SECRETS)) {
    const found = findSecret(key);
    out[key] = {
      label: meta.label,
      hint: meta.hint,
      masked: maskSecret(found?.value),
      ...(found && found.name !== key ? { storedAs: found.name } : {}),
    };
  }
  return out;
}

/** The bearer a request carries, if any. */
function bearerOf(req: ApiRequest): string | undefined {
  const auth = header(req.headers ?? {}, "authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
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
/**
 * A build's log, as it happens.
 *
 * Polling is fine for a list and wrong for a log: output arrives in bursts,
 * and a page that samples every second and a half renders them as stutter.
 */
function streamBuilds(
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

  const send = (id: number): void => {
    const build = kernel.builds.get(id);
    if (build) res.write(`data: ${JSON.stringify(build)}\n\n`);
  };
  // Everything currently known, so a reader that arrives mid-build sees the
  // whole log rather than only what happens next.
  for (const build of kernel.builds.list()) send(build.id);

  const unwatch = kernel.builds.watch(send);
  const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
  const close = (): void => {
    clearInterval(beat);
    unwatch();
  };
  req.on("close", close);
  res.on("close", close);
}

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

  // Catch the reader up on whatever is already running before sending them
  // anything new. Without this a reload during a turn showed an empty space
  // where the thinking and the tool calls had been, until the turn ended.
  for (const event of kernel.progress.snapshot()) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

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

  if (body.task === "cheap" || body.task === "reasoning") input.task = body.task;
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
      if (method === "GET" && path === "/api/agents/stream") {
        streamBuilds(kernel, req, res, options);
        return;
      }

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
        // A route that answers with bytes has already said what they are; JSON
        // encoding them would turn an image into a list of numbers.
        else if (Buffer.isBuffer(result.body)) res.end(result.body);
        else res.end(JSON.stringify(result.body));
        return;
      }

      /*
       * A daemon the agent wrote, reached through here rather than by being on
       * the network itself. Ahead of the static handler because /apps is a
       * real path on the dashboard's origin, and behind /api because a daemon
       * must not be able to claim one of KOS's own routes.
       */
      if (
        proxyToDaemon(req, res, {
          store: kernel.daemons,
          supervisor: kernel.supervisor,
        })
      ) {
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
 * Refuse to change a thread that is not the owner's to change.
 *
 * Said here rather than left to the store, so the answer names the thing and
 * why. These were protected by the list not showing them, which protects
 * nothing: the endpoint took any id at all, and the router could be deleted
 * by anyone who guessed its name.
 */
function refuseFixed(
  kernel: Kernel,
  id: string,
  verb: string,
): { status: number; body: { error: string } } | null {
  const conversation = kernel.conversations.get(id);
  if (!conversation) return null;
  const kind = conversationKind(conversation, kernel.profile.ownerId);
  if (kind === "chat") return null;
  const what =
    kind === "orchestrator"
      ? "KOS itself"
      : kind === "surface"
        ? `the ${conversation.channel} stream`
        : "a schedule's own thread";
  return {
    status: 400,
    body: { error: `${what} cannot be ${verb}.` },
  };
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
