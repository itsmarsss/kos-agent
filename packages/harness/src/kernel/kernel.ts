import { runAgent, type Inference } from "../agent/loop.js";
import { ToolRegistry } from "../agent/registry.js";
import { runCronJob } from "../cron/executor.js";
import { CronScheduler } from "../cron/scheduler.js";
import { CronStore } from "../cron/store.js";
import {
  FactsStore,
  HashingEmbeddingProvider,
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
import { SessionStore } from "./session.js";

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
  "You are KOS, a personal assistant operating inside a sandboxed workspace. Use the available tools to help. Risky actions are queued for the owner's approval.";

const DEFAULT_BACKUP_CRON = "0 3 * * *";

function pickEmbedder(secrets: SecretsRegistry): EmbeddingProvider {
  const key = secrets.get("openai");
  if (key) {
    return new OpenAIEmbeddingProvider({
      apiKey: key,
      model: "text-embedding-3-small",
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
    const episodic = new EpisodicStore(workspace.db, embedder.dimension);
    const memoryWriter = new MemoryWriter(facts);
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
        const tools = this.guardedTools({
          userId,
          ...(inferred.length ? { scopeTags: inferred } : {}),
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
          this.sessions.appendTurn(sessionId, text, result.messages);
        }

        // Memory write path (salience) + episodic note for the exchange.
        void this.memoryWriter.ingest(userId, text, "chat").catch(() => undefined);
        void this.storeEpisode(
          userId,
          `user: ${text}\nassistant: ${result.finalText.slice(0, 500)}`,
        ).catch(() => undefined);

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
   * Approve a pending risky action, execute it, and optionally notify the owner
   * so the approval loop is closed with a visible result.
   */
  async approve(
    id: number,
    decidedBy?: string,
  ): Promise<{ ok: boolean; message: string; isError?: boolean }> {
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
    const summary = result.isError
      ? `Approved #${id} (${action.tool}) failed: ${result.content}`
      : `Approved #${id} (${action.tool}) ok: ${result.content.slice(0, 400)}`;
    if (this.notify) {
      void this.notify(summary).catch(() => undefined);
    }
    return { ok: true, message: result.content, isError: result.isError };
  }

  deny(id: number, decidedBy?: string): { ok: boolean; message: string } {
    const denied = this.approvals.deny(id, decidedBy ?? this.profile.ownerId);
    return denied
      ? { ok: true, message: `denied #${id}` }
      : { ok: false, message: `no pending action #${id}` };
  }

  clearSession(sessionId: string): void {
    this.sessions.clear(sessionId);
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
