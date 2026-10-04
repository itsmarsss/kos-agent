import { PressRoutes } from "../channels/presses.js";
import { DaemonStore } from "../daemons/store.js";
import { DaemonSupervisor } from "../daemons/supervisor.js";
import { ToolRegistry } from "../agent/registry.js";
import { CronStore } from "../cron/store.js";
import {
  FactsStore,
  CohereEmbeddingProvider,
  HashingEmbeddingProvider,
  LlmSalienceConfirmer,
  MemoryRetriever,
  MemoryWriter,
  OpenAIEmbeddingProvider,
  EventLog,
  type EmbeddingProvider,
} from "../memory/index.js";
import { createDefaultRouter } from "../models/router.js";
import { SpendStore } from "../ops/spend.js";
import { BuildRegistry } from "../builds/registry.js";
import { PendingMessages } from "./pending.js";
import { applyModelSettings, MODEL_SETTINGS_KEY, type ModelSettings } from "../models/settings.js";
import { SettingsStore } from "../store/settings.js";
import {
  ModuleLoader,
  toolRegistryContext,
  type KosModule,
  type ModuleServices,
} from "../modules/loader.js";
import { AuditLog } from "../ops/audit.js";
import { ApprovalQueue } from "../ops/approvals.js";
import { PersistentKillSwitch } from "../ops/killswitch.js";
import { HealthMonitor } from "../ops/health.js";
import { RunsLog } from "../ops/runs.js";
import { WorkQueue } from "../ops/queue.js";
import { WorkspaceBackup } from "../ops/backup.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { SkillPromoter } from "../skills/promote.js";
import { Workspace } from "../store/workspace.js";
import { InstanceConfig } from "../systems/config.js";
import { ProjectManifest } from "../systems/manifest.js";
import { Migrator } from "../systems/migrate.js";
import { PageStore } from "../systems/pages.js";
import { createHttpModule } from "../tools/http.js";
import { createMcpModule, readMcpConfig } from "../tools/mcp.js";
import { createModulesModule } from "../tools/modules.js";
import { MODULES_KEY, enabledServers, parseModuleSettings } from "../modules/workspace.js";
import { isContained } from "../sandbox/jail.js";
import { PermissionStore } from "../ops/permissions.js";
import { createDaemonsModule } from "../tools/daemons.js";
import { createSearchModule } from "../tools/search.js";
import { exportModule } from "../tools/export.js";
import { createShellModule } from "../tools/shell.js";
import { createSkillsModule } from "../tools/skills.js";
import { SKILLS_KEY, parseSkillSettings } from "../skills/settings.js";
import { createChatsModule } from "../tools/chats.js";
import { createMemoryModule } from "../tools/memory.js";
import { createCronModule } from "../tools/cron.js";
import { filesModule } from "../tools/files.js";
import { createNotifyModule, noticeText, type NotifyPayload } from "../tools/notify.js";
import { sqlModule } from "../tools/sql.js";
import { createBuildsModule } from "../tools/builds.js";
import { sitesModule } from "../tools/sites.js";
import { systemsModule } from "../tools/systems.js";
import { tasksModule } from "../tools/tasks.js";
import { ensureProfile } from "./profile.js";
import { RETENTION_KEY, SessionStore, primarySessionId, type Retention } from "./session.js";
import { ConversationStore } from "./conversations.js";
import { BUILD_SETTINGS_KEY, Kernel, orchestratorId, type KernelOptions } from "./kernel.js";

const DEFAULT_SYSTEM =
  "You are KOS, a personal assistant operating inside a sandboxed workspace. Use the available tools to help. Risky actions are queued for owner approval — tell the user the pending id, then wait; when approval results arrive (as a System message), continue the plan without repeating completed creates. Prefer short checklist-style replies when the user asks. For tasks: create_list once, then tasks.add/list/complete with the returned slug as instance.";

const PRESS_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SURFACE_THREADS_KEY = "surfaces.threaded";

/**
 * What the orchestrator is for. Deliberately about routing rather than any
 * particular kind of work: its job is to find where something belongs and set
 * it up, not to do the work itself.
 *
 * ORCHESTRATOR_SCOPE is the other half of this, and the half that holds. Told
 * only in prose to route, and handed the full toolkit, it built things inline
 * instead: a whole project would land in the Command thread, later work on it
 * had nowhere to go, and a page for one thing got written into whatever
 * project already existed. What it cannot reach, it has to delegate.
 */
const ORCHESTRATOR_BRIEF = [
  "You are the owner's router. You do not build things yourself. You find or create the conversation where a piece of work belongs, give it the task, and report back what it did.",
  "You deliberately have no tools for files, data, pages or schedules. Anything that needs them goes to a conversation. This is not a limitation to apologise for or work around; it is the job.",
  "Before starting anything, search existing conversations: the work often already has a home, and saying so is more useful than making another thread.",
  "When something genuinely needs its own conversation, create it with a brief saying what it is for, and give it the task at the same time. It runs immediately and its answer comes back to you.",
  "A task is an instruction to the agent, in the owner's voice: \"Create a directory called test-dir\". Never address the owner in it. A task that asks a question produces an agent that asks it back and does nothing.",
  "If the request is too vague to state a concrete task, ask the owner for the missing detail yourself. Do not hand the ambiguity to a new agent.",
  "Leave tools unrestricted. A new conversation gets the full toolkit unless the owner has asked you to limit it, because a guess about what it will need becomes a capability it silently lacks later.",
  "Creating a conversation and stopping is not an outcome: say what the agent actually did.",
  "Say it in a line or two of your own. Do not reproduce the agent\u2019s reply: the owner can open that conversation and read it there, and repeating it in full means they read the same thing twice.",
  "Dispatch to an existing conversation when one already covers the work, rather than creating a near-duplicate.",
  "Be brief. Say what you found, what you dispatched, and what it said.",
].join("\n");

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

/**
 * Composition: every store, module and service the kernel is made of,
 * wired and handed to its constructor. The kernel is what it does; this is
 * what it is made of. Boot had grown to a third of the kernel file and had
 * nothing to do with handling a turn.
 */

export async function bootKernel(options: KernelOptions): Promise<Kernel> {
  // Modules are constructed before the kernel exists, and one of them needs
  // to call back into it; this closes that loop without a partial `this`.
  // eslint-disable-next-line prefer-const
  let kernelRef: Kernel | undefined;
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
  const health = new HealthMonitor(workspace.db);
  const approvals = new ApprovalQueue(workspace.db, secrets);
  // Where a button press goes. A row, because the message it is on outlives
  // the process that sent it.
  const presses = new PressRoutes(workspace.db);
  // A button on a month-old message is not something anyone is about to
  // press, and the table only ever grows otherwise. Swept once at boot
  // rather than on a schedule of its own.
  presses.prune(PRESS_ROUTE_TTL_MS);

  const daemons = new DaemonStore(workspace.db);
  const permissions = new PermissionStore(workspace.db);
  const settings = new SettingsStore(workspace.db);
  /*
   * Servers from mcp.json, and the workspace's own modules the owner has
   * switched on, each run from its folder in the jail. A module that
   * shares a name with an mcp.json server loses: the owner's file wins.
   */
  const mcp = createMcpModule({
    workspaceRoot: workspace.root,
    secrets,
    config: () => {
      const servers = { ...readMcpConfig(workspace.root).servers };
      const enabled = parseModuleSettings(settings.get(MODULES_KEY)).enabled;
      for (const [name, server] of Object.entries(enabledServers(workspace, enabled, !isContained()))) {
        if (!(name in servers)) servers[name] = server;
      }
      return { servers };
    },
  });
  const supervisor = new DaemonSupervisor({
    workspaceRoot: workspace.root,
    // A daemon that has given up is news: it was running unattended, and
    // nobody is looking at a log they do not know to open.
    onCrash: (_daemon, reason) => kernelRef?.caretaker.tell(reason),
  });
  const spend = new SpendStore(workspace.db);
  const pending = new PendingMessages(workspace.db);
  const builds = new BuildRegistry(
    () => (kernelRef?.behaviour().stallMinutes ?? 3) * 60_000,
  );
  const killSwitch = new PersistentKillSwitch(workspace.db);
  const queue = new WorkQueue();
  const backup = new WorkspaceBackup(workspace.root);
  const promoter = new SkillPromoter({
    workspaceRoot: workspace.root,
    backup,
    approvals,
  });
  const sessions = new SessionStore(workspace.db);
  const conversations = new ConversationStore(workspace.db);
  const facts = new FactsStore(workspace.db);
  const embedder = pickEmbedder(secrets);
  const events = new EventLog(workspace.db, embedder.dimension, Date.now, embedder.name);
  const memoryRetriever = new MemoryRetriever(facts, events, embedder);

  const services: ModuleServices = {
    workspace,
    db: workspace.db,
    secrets,
    manifest,
    migrator,
    pages,
    // Always wired. Without a channel this used to be absent, so `notify`
    // threw and every unattended job that ended in "tell me" lost its
    // message. The fallback puts it where the owner already looks.
    notify: async (payload: NotifyPayload): Promise<string | undefined> => {
      /*
       * A turn that is answering a press has somewhere better to send than
       * the owner's inbox: back into the interaction the press opened.
       *
       * It is not a preference. A surface can make an interaction response
       * private and cannot make an ordinary message private at all, so a
       * card sent any other way during a press is a public card in answer
       * to a private button.
       */
      const open =
        payload.target.kind === "owner" && !payload.target.surface
          ? kernelRef?.replySurfaceFor(kernelRef.currentConversationId)
          : undefined;
      if (open) {
        await open({
          text: payload.text,
          ...(payload.card ? { card: payload.card } : {}),
          ...(payload.buttons ? { buttons: payload.buttons } : {}),
        });
        return "Sent as a reply to the press.";
      }

      if (options.notify) {
        await options.notify(payload);
        return;
      }
      /*
       * No channel is wired, so the dashboard is where the owner already
       * looks and a notice there is better than losing the message.
       *
       * Only for a message that did not ask for anywhere in particular. A
       * request to reach Telegram, or a specific channel, cannot be honoured
       * by writing a line on the dashboard, and answering "sent" to it is
       * how an agent comes to believe it has told someone something.
       */
      const { surface, kind } = payload.target;
      if (surface || kind !== "owner") {
        throw new Error(
          `no ${surface ?? "messaging"} surface is connected here, so that message has nowhere to go.`,
        );
      }
      kernelRef?.caretaker.record(noticeText(payload));
    },
  };

  const modules: KosModule[] = [
    filesModule,
    sqlModule,
    createNotifyModule({
      // A press is a message, so it needs somewhere to be a message in. The
      // caller may name a conversation; otherwise it lands back in the one
      // that put the button there.
      routePress: (button, replyTo) =>
        presses.register({
          conversationId:
            replyTo ??
            kernelRef?.currentConversationId ??
            primarySessionId(profile.ownerId),
          buttonId: button.id,
          label: button.label,
          // What the button opens and who may read the answer are part of
          // the button, and the surface hands back neither on a press.
          ...(button.modal ? { modal: button.modal } : {}),
          ...(button.ephemeral ? { ephemeral: true } : {}),
        }),
    }),
    createCronModule({
      // The same path the schedule uses, so a job tried by hand is a job
      // tried the way it will actually run.
      fire: async (id) => {
        const result = await kernelRef!.fireCron(id);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      },
    }),
    createHttpModule({
      // Passed through as given: the host supplies a function that reads
      // the environment, so saving in Settings takes effect on the next
      // call rather than the next restart.
      allowedHosts: options.allowedHosts ?? [],
    }),
    createSearchModule({ events, embedder }),
    createShellModule(),
    createModulesModule({
      enabled: () => parseModuleSettings(settings.get(MODULES_KEY)).enabled,
      status: () => mcp.status(),
    }),
    // Tools from the owner's MCP servers, as any other module's tools.
    mcp,
    createDaemonsModule({
      store: daemons,
      supervisor,
      workspaceRoot: workspace.root,
      urlFor: (daemon) =>
        daemon.port === null ? null : `/apps/${daemon.project}/${daemon.name}/`,
    }),
    systemsModule,
    sitesModule,
    createBuildsModule({
      approvals,
      registry: builds,
      userId: profile.ownerId,
      currentConversationId: () => kernelRef?.currentConversationId,
      // A build runs for minutes inside one tool call. Its narration goes
      // out on the reasoning stream, which is already where a reader looks
      // to see what is happening rather than whether it has hung.
      onEvent: (event) => {
        const conversationId = kernelRef?.currentConversationId;
        if (!conversationId) return;
        kernelRef?.progress.emit({
          kind: "delta",
          conversationId,
          of: "reasoning",
          text: `${event.text}\n`,
        });
      },
      model: () => settings.get<{ buildModel?: string }>(BUILD_SETTINGS_KEY)?.buildModel,
      /*
       * A build usually runs from an approval, which is outside any turn, so
       * nothing had opened a live turn for it. Its progress arrived for a
       * conversation the reader's view had no live entry for, and no
       * turn-end ever came, so the chat sat on a thinking indicator that
       * would not clear. Framing it makes the chat show the build working
       * and then stop.
       */
      // A build outlives the turn that started it, so its ending is news
      // rather than part of the conversation: shown where a command's
      // answer is shown, and told to the owner wherever they are.
      onFinished: (summary, conversationId) => {
        if (conversationId) {
          kernelRef?.progress.emit({
            kind: "note",
            conversationId,
            text: summary,
          });
        }
        kernelRef?.caretaker.tell(summary);
      },
      frame: (phase) => {
        const conversationId = kernelRef?.currentConversationId;
        if (!conversationId) return;
        kernelRef?.progress.emit({
          kind: phase === "start" ? "turn-start" : "turn-end",
          conversationId,
        });
      },
    }),
    tasksModule,
    exportModule,
    createSkillsModule({
      promoter,
      // Read on every call, so a toggle in Settings takes effect at once.
      disabled: () => parseSkillSettings(settings.get(SKILLS_KEY)).disabled,
    }),
    createMemoryModule({
      facts,
      events,
      embedder,
      ownerId: profile.ownerId,
      // The project the writing conversation belongs to, so a claim made
      // inside a project chat lands in that project's scope by default.
      currentProject: () => {
        const id = kernelRef?.currentConversationId;
        return id ? (conversations.get(id)?.projectSlug ?? undefined) : undefined;
      },
      // Attributed to the conversation that wrote it, so the owner can see
      // which agent believed what.
      currentSource: () => kernelRef?.currentConversationId ?? "agent",
    }),
    createChatsModule({
      conversations,
      sessions,
      ownerId: profile.ownerId,
      // Bound late: the kernel does not exist yet while modules are built.
      dispatch: (id, text) => kernelRef!.dispatchTo(id, text),
      currentConversationId: () => kernelRef?.currentConversationId,
      // Which project the caller belongs to, so a project orchestrator sees
      // its own project and nothing else.
      scope: () => {
        const id = kernelRef?.currentConversationId;
        return (id && conversations.get(id)?.projectSlug) || undefined;
      },
      // The answer lands as a note in the chat that delegated, and is told
      // to the owner as well so it is not lost if they are elsewhere.
      onDispatchDone: (id, title, reply, from) => {
        const summary = `${title} answered: ${reply.slice(0, 600)}`;
        if (from) {
          kernelRef?.progress.emit({
            kind: "note",
            conversationId: from,
            text: summary,
          });
        }
        kernelRef?.caretaker.tell(summary);
      },
      // It should not offer you its own thread as somewhere to put work.
      hide: [orchestratorId(profile.ownerId)],
    }),
    ...(options.extraModules ?? []),
  ];
  const loader = new ModuleLoader(toolRegistryContext(registry, services));
  const loadReport = await loader.load(modules);

  ensureDefaultBackupCron(crons);

  // The pre-existing primary session becomes the first conversation, so an
  // upgraded workspace keeps its transcript instead of orphaning it.
  const primaryId = primarySessionId(profile.ownerId);
  if (!conversations.get(primaryId)) {
    conversations.create({
      id: primaryId,
      userId: profile.ownerId,
      title: "Main",
    });
  }

  // The orchestrator is a real conversation so it remembers what it has set
  // up and why, rather than re-deriving it from scratch every invocation.
  const orchestrator = orchestratorId(profile.ownerId);
  const existing = conversations.get(orchestrator);
  if (!existing) {
    conversations.create({
      id: orchestrator,
      userId: profile.ownerId,
      title: "KOS",
      brief: ORCHESTRATOR_BRIEF,
    });
  }

  // Retention the owner set, applied before any turn reads history, so a
  // restart does not quietly go back to the defaults.
  /*
   * Retire pointers set before surfaces had threads of their own.
   *
   * conversationFor reads the pointer first, so one set under the old rules
   * -- where the default was "whatever was touched last" -- goes on winning
   * over the surface's own stream forever. A workspace that had ever
   * received a message on a surface would never see the new home at all.
   * Done once and remembered, so a deliberate /switch made afterwards is
   * left alone.
   */
  if (!settings.get<boolean>(SURFACE_THREADS_KEY)) {
    const dropped = conversations.clearActive();
    settings.set(SURFACE_THREADS_KEY, true);
    if (dropped > 0) {
      console.log(
        `[kos] surfaces now have their own threads; ${dropped} old pointer${
          dropped === 1 ? "" : "s"
        } retired`,
      );
    }
  }

  const retention = settings.get<Partial<Retention>>(RETENTION_KEY);
  if (retention) sessions.configure(retention);
  /*
   * Trimming was silent: a conversation lost its early turns and the only
   * sign was the agent no longer knowing something it had been told. Said
   * where a command's answer is said, which is a note beside the thread
   * rather than a message in it.
   */
  sessions.watch((dropped, kept) => {
    const id = kernelRef?.currentConversationId;
    if (!id) return;
    kernelRef?.progress.emit({
      kind: "note",
      conversationId: id,
      text: `Trimmed ${dropped} older exchange${dropped === 1 ? "" : "s"} from this chat to stay inside the history budget. ${kept} kept. /compact turns the old ones into a summary instead, and Settings can raise the budget or turn trimming off.`,
    });
  });
  const router = options.inference ? undefined : createDefaultRouter(secrets);
  // Saved model choices are applied before anything runs, so the first turn
  // after a restart uses what the owner picked rather than the default.
  if (router) {
    applyModelSettings(router, settings.get<ModelSettings>(MODEL_SETTINGS_KEY));
  }
  const inference = options.inference ?? router!;

  // Every response's token count, attributed to whatever conversation was
  // being worked on. Providers report this and it was being thrown away, so
  // there was no way to answer "what is this costing me" from inside KOS.
  if (router) {
    router.onUsage = (event) => {
      spend.record({
        conversationId: kernelRef?.currentConversationId ?? null,
        task: event.task,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        // The cached share, so a reused prefix is priced as one. Both
        // providers report it; neither was being read.
        ...(event.cacheReadTokens
          ? { cacheReadTokens: event.cacheReadTokens }
          : {}),
        ...(event.cacheWriteTokens
          ? { cacheCreationTokens: event.cacheWriteTokens }
          : {}),
      });
    };
  }

  // Hybrid salience: heuristics decide outright, the cheap model confirms and
  // structures whatever they only flag as "maybe".
  const memoryWriter = new MemoryWriter(
    facts,
    new LlmSalienceConfirmer(inference),
  );

  kernelRef = new Kernel({
    loader,
    mcp,
    permissions,
    workspace,
    secrets,
    registry,
    manifest,
    migrator,
    config,
    pages,
    crons,
    spend,
    pending,
    builds,
    audit,
    runs,
    health,
    approvals,
    killSwitch,
    queue,
    backup,
    promoter,
    profile,
    loadReport,
    sessions,
    conversations,
    facts,
    presses,
    daemons,
    supervisor,
    settings,
    memoryWriter,
    memoryRetriever,
    embedder,
    events,
    inference,
    system: options.system ?? DEFAULT_SYSTEM,
    sessionless: options.sessionless === true,
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.onApprovalRequested
      ? { onApprovalRequested: options.onApprovalRequested }
      : {}),
  });
  return kernelRef;
}
