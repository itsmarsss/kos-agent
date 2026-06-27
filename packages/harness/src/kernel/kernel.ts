import { runAgent, type Inference } from "../agent/loop.js";
import { ToolRegistry } from "../agent/registry.js";
import { CronStore } from "../cron/store.js";
import { createDefaultRouter } from "../models/router.js";
import {
  ModuleLoader,
  toolRegistryContext,
  type KosModule,
  type LoadReport,
  type ModuleServices,
} from "../modules/loader.js";
import { AuditLog } from "../ops/audit.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { PersistentKillSwitch } from "../ops/killswitch.js";
import { RunsLog } from "../ops/runs.js";
import { WorkQueue } from "../ops/queue.js";
import { WorkspaceBackup } from "../ops/backup.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { InstanceConfig } from "../systems/config.js";
import { ProjectManifest } from "../systems/manifest.js";
import { Migrator } from "../systems/migrate.js";
import { createHttpModule } from "../tools/http.js";
import { createSearchModule } from "../tools/search.js";
import { cronModule } from "../tools/cron.js";
import { filesModule } from "../tools/files.js";
import { notifyModule } from "../tools/notify.js";
import { sqlModule } from "../tools/sql.js";
import { GuardedTools } from "./guarded.js";
import { ensureProfile, type Profile } from "./profile.js";

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
}

export interface HandleResult {
  reply: string;
  halted: boolean;
}

const DEFAULT_SYSTEM =
  "You are KOS, a personal assistant operating inside a sandboxed workspace. Use the available tools to help. Risky actions are queued for the owner's approval.";

/**
 * The assembled agent. The kernel wires the irreducible core (store, jail,
 * router, loader, agent loop) and loads the first-party modules, then exposes a
 * single entry point: handleMessage runs the guarded agent loop (scoped tools,
 * secret injection, approval gating, audit) inside the serial work queue with
 * run logging, and respects the kill switch.
 */
export class Kernel {
  readonly workspace: Workspace;
  readonly secrets: SecretsRegistry;
  readonly registry: ToolRegistry;
  readonly manifest: ProjectManifest;
  readonly migrator: Migrator;
  readonly config: InstanceConfig;
  readonly crons: CronStore;
  readonly audit: AuditLog;
  readonly runs: RunsLog;
  readonly approvals: ApprovalQueue;
  readonly killSwitch: PersistentKillSwitch;
  readonly queue: WorkQueue;
  readonly backup: WorkspaceBackup;
  readonly profile: Profile;
  readonly loadReport: LoadReport;

  private readonly inference: Inference;
  private readonly system: string;

  private constructor(args: {
    workspace: Workspace;
    secrets: SecretsRegistry;
    registry: ToolRegistry;
    manifest: ProjectManifest;
    migrator: Migrator;
    config: InstanceConfig;
    crons: CronStore;
    audit: AuditLog;
    runs: RunsLog;
    approvals: ApprovalQueue;
    killSwitch: PersistentKillSwitch;
    queue: WorkQueue;
    backup: WorkspaceBackup;
    profile: Profile;
    loadReport: LoadReport;
    inference: Inference;
    system: string;
  }) {
    this.workspace = args.workspace;
    this.secrets = args.secrets;
    this.registry = args.registry;
    this.manifest = args.manifest;
    this.migrator = args.migrator;
    this.config = args.config;
    this.crons = args.crons;
    this.audit = args.audit;
    this.runs = args.runs;
    this.approvals = args.approvals;
    this.killSwitch = args.killSwitch;
    this.queue = args.queue;
    this.backup = args.backup;
    this.profile = args.profile;
    this.loadReport = args.loadReport;
    this.inference = args.inference;
    this.system = args.system;
  }

  static async boot(options: KernelOptions): Promise<Kernel> {
    const workspace = Workspace.open(options.rootDir);
    const secrets = options.secrets ?? SecretsRegistry.fromEnv();
    const profile = ensureProfile(workspace, options.profileOverrides);
    const registry = new ToolRegistry();

    const manifest = new ProjectManifest(workspace.db);
    const migrator = new Migrator(workspace.db, manifest);
    const config = new InstanceConfig(workspace.db);
    const crons = new CronStore(workspace.db);
    const audit = new AuditLog(workspace.db, secrets);
    const runs = new RunsLog(workspace.db);
    const approvals = new ApprovalQueue(workspace.db, secrets);
    const killSwitch = new PersistentKillSwitch(workspace.db);
    const queue = new WorkQueue();
    const backup = new WorkspaceBackup(workspace.root);

    const services: ModuleServices = {
      workspace,
      db: workspace.db,
      secrets,
      ...(options.notify ? { notify: options.notify } : {}),
    };

    const modules: KosModule[] = [
      filesModule,
      sqlModule,
      notifyModule,
      cronModule,
      createHttpModule({ allowedHosts: options.allowedHosts ?? [] }),
      createSearchModule(),
      ...(options.extraModules ?? []),
    ];
    const loader = new ModuleLoader(toolRegistryContext(registry, services));
    const loadReport = await loader.load(modules);

    const inference =
      options.inference ?? createDefaultRouter(secrets);

    return new Kernel({
      workspace,
      secrets,
      registry,
      manifest,
      migrator,
      config,
      crons,
      audit,
      runs,
      approvals,
      killSwitch,
      queue,
      backup,
      profile,
      loadReport,
      inference,
      system: options.system ?? DEFAULT_SYSTEM,
    });
  }

  /**
   * Handle one inbound message: run the guarded agent loop serially through the
   * work queue, with a runs-log entry. Returns the reply, or a halted notice
   * when the kill switch is engaged.
   */
  async handleMessage(
    text: string,
    opts: { scopeTags?: string[]; userId?: string } = {},
  ): Promise<HandleResult> {
    if (this.killSwitch.halted) {
      return { reply: "KOS is halted (kill switch engaged).", halted: true };
    }
    return this.queue.enqueue(async () => {
      const runId = this.runs.start("chat");
      try {
        const tools = new GuardedTools({
          registry: this.registry,
          secrets: this.secrets,
          audit: this.audit,
          approvals: this.approvals,
          userId: opts.userId ?? this.profile.ownerId,
          ...(opts.scopeTags ? { scopeTags: opts.scopeTags } : {}),
        });
        const result = await runAgent(this.inference, tools, text, {
          system: this.system,
        });
        this.runs.finish(runId, "ok");
        return { reply: result.finalText, halted: false };
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

  close(): void {
    this.workspace.close();
  }
}
