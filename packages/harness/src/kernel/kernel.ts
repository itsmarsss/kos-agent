import { runAgent, type Inference } from "../agent/loop.js";
import { ToolRegistry } from "../agent/registry.js";
import { runCronJob } from "../cron/executor.js";
import { CronScheduler } from "../cron/scheduler.js";
import { CronStore } from "../cron/store.js";
import {
  FactsStore,
  CohereEmbeddingProvider,
  HashingEmbeddingProvider,
  LlmSalienceConfirmer,
  MemoryRetriever,
  MemoryWriter,
  OpenAIEmbeddingProvider,
  EpisodicStore,
  type EmbeddingProvider,
} from "../memory/index.js";
import type { ModelMessage } from "../models/types.js";
import { createDefaultRouter } from "../models/router.js";
import {
  ModuleLoader,
  toolRegistryContext,
  type KosModule,
  type LoadReport,
  type ModuleServices,
} from "../modules/loader.js";
import { AuditLog } from "../ops/audit.js";
import { ApprovalQueue, type PendingAction } from "../ops/approvals.js";
import { PersistentKillSwitch } from "../ops/killswitch.js";
import { RunsLog } from "../ops/runs.js";
import { WorkQueue } from "../ops/queue.js";
import { WorkspaceBackup } from "../ops/backup.js";
import { injectSecrets } from "../secrets/inject.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { SkillPromoter, type PromoteInput, type PromoteOutcome } from "../skills/promote.js";
import { Workspace } from "../store/workspace.js";
import { InstanceConfig } from "../systems/config.js";
import { ProjectManifest } from "../systems/manifest.js";
import { Migrator } from "../systems/migrate.js";
import { PageStore } from "../systems/pages.js";
import { createHttpModule } from "../tools/http.js";
import { createSearchModule } from "../tools/search.js";
import { cronModule } from "../tools/cron.js";
import { filesModule } from "../tools/files.js";
import { notifyModule } from "../tools/notify.js";
import { sqlModule } from "../tools/sql.js";
import { systemsModule } from "../tools/systems.js";
import { tasksModule } from "../tools/tasks.js";
import { assembleSystemPrompt, inferScopeTags } from "./context.js";
import { GuardedTools } from "./guarded.js";
import { ensureProfile, type Profile } from "./profile.js";
import { SessionStore, primarySessionId } from "./session.js";

export interface KernelOptions {
  rootDir: string;
  secrets?: SecretsRegistry;
  /** Inference override (tests inject a stub); defaults to the model router. */
  inference?: Inference;
  /** Send a message to the owner via the active channel adapter. */
  notify?: (text: string) => Promise<void>;
  /** Additional (e.g. agent-promoted or third-party) modules to load. */
  extraModules?: KosModule[];
  /** Hosts the http.fetch tool may reach. */
  allowedHosts?: string[];
  profileOverrides?: Partial<Profile>;
  system?: string;
  /** Notified when a risky action is queued (e.g. to render Discord buttons). */
  onApprovalRequested?: (action: PendingAction) => void;
  /** Disable session history (tests). */
  sessionless?: boolean;
}

export interface HandleResult {
  reply: string;
  halted: boolean;
  sessionId?: string;
}

const DEFAULT_SYSTEM =
  "You are KOS, a personal assistant operating inside a sandboxed workspace. Use the available tools to help. Risky actions are queued for owner approval — tell the user the pending id, then wait; when approval results arrive (as a System message), continue the plan without repeating completed creates. Prefer short checklist-style replies when the user asks. For tasks: create_list once, then tasks.add/list/complete with the returned slug as instance.";

const DEFAULT_BACKUP_CRON = "0 3 * * *";

/**
 * Pick the embedding provider from available secrets. Cohere is here so an
 * Anthropic-only .env still gets real semantic recall; the hashing provider is
 * a lexical last resort, not a semantic one, and callers say so.
 */
function pickEmbedder(secrets: SecretsRegistry): EmbeddingProvider {
  const openai = secrets.get("openai");
  if (openai) {
    return new OpenAIEmbeddingProvider({
      apiKey: openai,
      model: "text-embedding-3-small",
      dimension: 256,
    });
  }
  const cohere = secrets.get("cohere");
  if (cohere) {
    return new CohereEmbeddingProvider({
      apiKey: cohere,
      model: "embed-english-v3.0",
      dimension: 256,
    });
  }
  return new HashingEmbeddingProvider(256);
}

/**
 * The assembled agent. The kernel wires the irreducible core (store, jail,
 * router, loader, agent loop) and loads the first-party modules, then exposes a
 * single entry point: handleMessage runs the guarded agent loop (scoped tools,
 * secret injection, approval gating, audit, memory, session history) inside the
 * serial work queue with run logging, and respects the kill switch.
 */
export class Kernel {
  readonly workspace: Workspace;
  readonly secrets: SecretsRegistry;
  readonly registry: ToolRegistry;
  readonly manifest: ProjectManifest;
  readonly migrator: Migrator;
  readonly config: InstanceConfig;
  readonly pages: PageStore;
  readonly crons: CronStore;
  readonly audit: AuditLog;
  readonly runs: RunsLog;
  readonly approvals: ApprovalQueue;
  readonly killSwitch: PersistentKillSwitch;
  readonly queue: WorkQueue;
  readonly backup: WorkspaceBackup;
  readonly promoter: SkillPromoter;
  readonly profile: Profile;
  readonly loadReport: LoadReport;
  readonly sessions: SessionStore;
  readonly facts: FactsStore;
  readonly memoryWriter: MemoryWriter;
  readonly memoryRetriever: MemoryRetriever;

  private readonly inference: Inference;
  private readonly system: string;
  private readonly onApprovalRequested?: (action: PendingAction) => void;
  private readonly notify?: (text: string) => Promise<void>;
  private readonly sessionless: boolean;
  private readonly embedder: EmbeddingProvider;
  private readonly episodic: EpisodicStore;
  private scheduler?: CronScheduler;
  /**
   * Scope tags accumulated per session. Inference reads only the latest
   * message, so a follow-up that happens to match no keyword would otherwise
   * drop the tools the conversation has been using. Scope only ever grows
   * within a session; clearing the session clears it.
   */
  private readonly sessionScope = new Map<string, Set<string>>();

  private constructor(args: {
    workspace: Workspace;
    secrets: SecretsRegistry;
    registry: ToolRegistry;
    manifest: ProjectManifest;
    migrator: Migrator;
    config: InstanceConfig;
    pages: PageStore;
    crons: CronStore;
    audit: AuditLog;
    runs: RunsLog;
    approvals: ApprovalQueue;
    killSwitch: PersistentKillSwitch;
    queue: WorkQueue;
    backup: WorkspaceBackup;
    promoter: SkillPromoter;
    profile: Profile;
    loadReport: LoadReport;
    sessions: SessionStore;
    facts: FactsStore;
    memoryWriter: MemoryWriter;
    memoryRetriever: MemoryRetriever;
    embedder: EmbeddingProvider;
    episodic: EpisodicStore;
    inference: Inference;
    system: string;
    sessionless: boolean;
    notify?: (text: string) => Promise<void>;
    onApprovalRequested?: (action: PendingAction) => void;
  }) {
    this.workspace = args.workspace;
    this.secrets = args.secrets;
    this.registry = args.registry;
    this.manifest = args.manifest;
    this.migrator = args.migrator;
    this.config = args.config;
    this.pages = args.pages;
    this.crons = args.crons;
    this.audit = args.audit;
    this.runs = args.runs;
    this.approvals = args.approvals;
    this.killSwitch = args.killSwitch;
    this.queue = args.queue;
    this.backup = args.backup;
    this.promoter = args.promoter;
    this.profile = args.profile;
    this.loadReport = args.loadReport;
    this.sessions = args.sessions;
    this.facts = args.facts;
    this.memoryWriter = args.memoryWriter;
    this.memoryRetriever = args.memoryRetriever;
    this.embedder = args.embedder;
    this.episodic = args.episodic;
    this.inference = args.inference;
    this.system = args.system;
    this.sessionless = args.sessionless;
    this.notify = args.notify;
    this.onApprovalRequested = args.onApprovalRequested;
  }

  static async boot(options: KernelOptions): Promise<Kernel> {
    const workspace = Workspace.open(options.rootDir);
    const secrets = options.secrets ?? SecretsRegistry.fromEnv();
    const profile = ensureProfile(workspace, options.profileOverrides);
    const registry = new ToolRegistry();

    const manifest = new ProjectManifest(workspace.db);
    const migrator = new Migrator(workspace.db, manifest);
    const config = new InstanceConfig(workspace.db);
    const pages = new PageStore(workspace.db, workspace, manifest);
    const crons = new CronStore(workspace.db);
    const audit = new AuditLog(workspace.db, secrets);
    const runs = new RunsLog(workspace.db);
    const approvals = new ApprovalQueue(workspace.db, secrets);
    const killSwitch = new PersistentKillSwitch(workspace.db);
    const queue = new WorkQueue();
    const backup = new WorkspaceBackup(workspace.root);
    const promoter = new SkillPromoter({
      workspaceRoot: workspace.root,
      backup,
      approvals,
    });
    const sessions = new SessionStore(workspace.db);
    const facts = new FactsStore(workspace.db);
    const embedder = pickEmbedder(secrets);
    const episodic = new EpisodicStore(
      workspace.db,
      embedder.dimension,
      Date.now,
      embedder.name,
    );
    const memoryRetriever = new MemoryRetriever(facts, episodic, embedder);

    const services: ModuleServices = {
      workspace,
      db: workspace.db,
      secrets,
      manifest,
      migrator,
      pages,
      ...(options.notify ? { notify: options.notify } : {}),
    };

    const modules: KosModule[] = [
      filesModule,
      sqlModule,
      notifyModule,
      cronModule,
      createHttpModule({ allowedHosts: options.allowedHosts ?? [] }),
      createSearchModule(),
      systemsModule,
      tasksModule,
      ...(options.extraModules ?? []),
    ];
    const loader = new ModuleLoader(toolRegistryContext(registry, services));
    const loadReport = await loader.load(modules);

    ensureDefaultBackupCron(crons);

    const inference =
      options.inference ?? createDefaultRouter(secrets);

    // Hybrid salience: heuristics decide outright, the cheap model confirms and
    // structures whatever they only flag as "maybe".
    const memoryWriter = new MemoryWriter(
      facts,
      new LlmSalienceConfirmer(inference),
    );

    return new Kernel({
      workspace,
      secrets,
      registry,
      manifest,
      migrator,
      config,
      pages,
      crons,
      audit,
      runs,
      approvals,
      killSwitch,
      queue,
      backup,
      promoter,
      profile,
      loadReport,
      sessions,
      facts,
      memoryWriter,
      memoryRetriever,
      embedder,
      episodic,
      inference,
      system: options.system ?? DEFAULT_SYSTEM,
      sessionless: options.sessionless === true,
      ...(options.notify ? { notify: options.notify } : {}),
      ...(options.onApprovalRequested
        ? { onApprovalRequested: options.onApprovalRequested }
        : {}),
    });
  }

  promoteSkill(input: PromoteInput): Promise<PromoteOutcome> {
    return this.promoter.promote(input);
  }

  /**
   * Handle one inbound message with session history, context assembly, memory
   * read on the way in and write on the way out.
   */
  async handleMessage(
    text: string,
    opts: {
      scopeTags?: string[];
      userId?: string;
      sessionId?: string;
      /** Skip session history for this turn only. */
      noSession?: boolean;
      /**
       * Who this turn came from. "system" marks harness-generated turns (an
       * approval resume, say) so they are not mistaken for owner speech by the
       * memory salience pass.
       */
      origin?: "owner" | "system";
    } = {},
  ): Promise<HandleResult> {
    if (this.killSwitch.halted) {
      return { reply: "KOS is halted (kill switch engaged).", halted: true };
    }
    const userId = opts.userId ?? this.profile.ownerId;
    const sessionId =
      opts.sessionId ?? `chat:${userId}`;

    return this.queue.enqueue(async () => {
      const runId = this.runs.start("chat");
      try {
        const inferred = opts.scopeTags ?? inferScopeTags(text);
        const scopeTags = this.accumulateScope(sessionId, inferred);
        const tools = this.guardedTools({
          userId,
          ...(scopeTags.length ? { scopeTags } : {}),
        });

        const recall = await this.memoryRetriever.recall(userId, text, {
          factLimit: 10,
          episodeLimit: 4,
          minFactsBeforeVector: 2,
        });
        const system = assembleSystemPrompt({
          baseSystem: this.system,
          profile: this.profile,
          projects: this.manifest.list(),
          recall,
        });

        let input: string | ModelMessage[] = text;
        const useSession = !this.sessionless && !opts.noSession;
        if (useSession) {
          const prior = this.sessions.historyForPrompt(sessionId);
          input = [
            ...prior,
            { role: "user", content: [{ type: "text", text }] },
          ];
        }

        const result = await runAgent(this.inference, tools, input, {
          system,
        });

        if (useSession) {
          // Persist the loop's own message list so tool calls and their results
          // survive into the next turn, not just the final text.
          this.sessions.record(sessionId, result.messages);
        }

        // Memory write path (salience) + episodic note for the exchange. Only
        // owner turns are remembered; harness-generated turns are plumbing.
        // Awaited so a write cannot be lost when the process exits right after
        // a reply, and so failures surface in the runs log instead of vanishing.
        if (opts.origin !== "system") {
          await this.rememberExchange(userId, text, result.finalText);
        }

        this.runs.finish(runId, "ok");
        return {
          reply: result.finalText,
          halted: false,
          sessionId,
        };
      } catch (err) {
        this.runs.finish(
          runId,
          "error",
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }
    });
  }

  /**
   * Approve a pending risky action, execute it, resume the agent so it can
   * finish the plan, and notify the owner with the continuation reply.
   */
  async approve(
    id: number,
    decidedBy?: string,
  ): Promise<{
    ok: boolean;
    message: string;
    isError?: boolean;
    reply?: string;
  }> {
    const action = this.approvals.get(id);
    if (!action || action.status !== "pending") {
      return { ok: false, message: `no pending action #${id}` };
    }
    this.approvals.approve(id, decidedBy ?? this.profile.ownerId);
    const stored = JSON.parse(action.args) as Record<string, unknown>;
    const result = await this.registry.execute(
      action.tool,
      injectSecrets(stored, this.secrets),
    );
    this.audit.record({
      tool: action.tool,
      args: stored,
      result: result.content,
      isError: result.isError,
      riskTier: "risky",
      userId: decidedBy ?? this.profile.ownerId,
    });

    const userId = decidedBy ?? this.profile.ownerId;
    const sessionId = primarySessionId(this.profile.ownerId);
    const outcome = result.isError ? "FAILED" : "SUCCEEDED";
    const resumePrompt = [
      `System: the owner approved pending action #${id}.`,
      `tool=${action.tool}`,
      `outcome=${outcome}`,
      `result=${result.content}`,
      "Continue the owner's prior request now.",
      "Do not re-create resources that already exist (use slugs/ids from result).",
      "If this was tasks.create_list, use tasks.add / tasks.list with the returned slug as instance.",
      "Prefer short checklist-style replies.",
    ].join(" ");

    let reply: string | undefined;
    try {
      const cont = await this.handleMessage(resumePrompt, {
        sessionId,
        userId,
        origin: "system",
      });
      reply = cont.reply;
    } catch (err) {
      reply = `Approved #${id} but resume failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Channel/CLI deliver `reply` to the owner (avoid double-notify here).
    return {
      ok: true,
      message: result.content,
      isError: result.isError,
      ...(reply !== undefined ? { reply } : {}),
    };
  }

  async deny(
    id: number,
    decidedBy?: string,
  ): Promise<{ ok: boolean; message: string; reply?: string }> {
    const denied = this.approvals.deny(id, decidedBy ?? this.profile.ownerId);
    if (!denied) {
      return { ok: false, message: `no pending action #${id}` };
    }
    const sessionId = primarySessionId(this.profile.ownerId);
    let reply: string | undefined;
    try {
      const cont = await this.handleMessage(
        `System: the owner denied pending action #${id}. Acknowledge briefly and ask how to proceed without that action.`,
        {
          sessionId,
          userId: decidedBy ?? this.profile.ownerId,
          origin: "system",
        },
      );
      reply = cont.reply;
    } catch {
      reply = `Denied #${id}.`;
    }
    return {
      ok: true,
      message: `denied #${id}`,
      ...(reply !== undefined ? { reply } : {}),
    };
  }

  clearSession(sessionId: string): void {
    this.sessions.clear(sessionId);
    this.sessionScope.delete(sessionId);
  }

  /** Union this turn's inferred tags into the session's running scope. */
  private accumulateScope(sessionId: string, inferred: string[]): string[] {
    const existing = this.sessionScope.get(sessionId) ?? new Set<string>();
    for (const tag of inferred) existing.add(tag);
    this.sessionScope.set(sessionId, existing);
    return [...existing];
  }

  /**
   * Persist what this exchange is worth remembering. Memory is best-effort: a
   * failed write must never fail the user's turn, but it must not be invisible
   * either, so each failure is logged as its own run.
   */
  private async rememberExchange(
    userId: string,
    text: string,
    finalText: string,
  ): Promise<void> {
    const record = async (
      label: string,
      write: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await write();
      } catch (err) {
        const runId = this.runs.start(label);
        this.runs.finish(
          runId,
          "error",
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    await record("memory.facts", () =>
      this.memoryWriter.ingest(userId, text, "chat"),
    );
    await record("memory.episodic", () =>
      this.storeEpisode(
        userId,
        `user: ${text}\nassistant: ${finalText.slice(0, 500)}`,
      ),
    );
  }

  private async storeEpisode(userId: string, text: string): Promise<void> {
    const [embedding] = await this.embedder.embed([text]);
    if (embedding) this.episodic.add(userId, text, embedding);
  }

  private guardedTools(opts: {
    scopeTags?: string[];
    userId?: string;
  } = {}): GuardedTools {
    return new GuardedTools({
      registry: this.registry,
      secrets: this.secrets,
      audit: this.audit,
      approvals: this.approvals,
      userId: opts.userId ?? this.profile.ownerId,
      toolLimit: 48,
      ...(opts.scopeTags ? { scopeTags: opts.scopeTags } : {}),
      ...(this.onApprovalRequested
        ? { onQueued: this.onApprovalRequested }
        : {}),
    });
  }

  startCron(): void {
    this.scheduler = new CronScheduler(
      this.crons,
      (job) =>
        this.queue.enqueue(async () => {
          const runId = this.runs.start("cron", String(job.id));
          try {
            // Built-in workspace backup job runs outside the tool path.
            if (job.name === "kos.backup" && job.type === "actions") {
              await this.backup.ensureRepo();
              await this.backup.snapshot("scheduled backup");
              this.runs.finish(runId, "ok");
              return { ran: true, results: [] };
            }
            const result = await runCronJob(job, {
              db: this.workspace.db,
              tools: this.guardedTools(),
              inference: this.inference,
            });
            this.runs.finish(runId, result.ran ? "ok" : "skipped");
            return result;
          } catch (err) {
            this.runs.finish(
              runId,
              "error",
              err instanceof Error ? err.message : String(err),
            );
            throw err;
          }
        }),
      { killSwitch: this.killSwitch },
    );
    this.scheduler.start();
  }

  reloadCron(): void {
    this.scheduler?.reload();
  }

  stopCron(): void {
    this.scheduler?.stop();
    this.scheduler = undefined;
  }

  close(): void {
    this.stopCron();
    this.workspace.close();
  }
}

/** Seed a nightly workspace git snapshot if the owner has not defined one. */
function ensureDefaultBackupCron(crons: CronStore): void {
  const existing = crons.list().find((j) => j.name === "kos.backup");
  if (existing) return;
  crons.create({
    name: "kos.backup",
    schedule: DEFAULT_BACKUP_CRON,
    type: "actions",
    actions: [],
    enabled: true,
  });
}
