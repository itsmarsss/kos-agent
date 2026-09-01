import { runAgent, type Inference } from "../agent/loop.js";
import { ToolRegistry } from "../agent/registry.js";
import { runCronJob } from "../cron/executor.js";
import { CronScheduler } from "../cron/scheduler.js";
import { CronStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
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
import type { ContentBlock, ModelMessage } from "../models/types.js";
import { createDefaultRouter, type RouteSummary } from "../models/router.js";
import { SpendStore } from "../ops/spend.js";
import { BuildRegistry } from "../builds/registry.js";
import { PendingMessages, type PendingMessage } from "./pending.js";
import {
  applyModelSettings,
  MODEL_SETTINGS_KEY,
  type ModelSettings,
} from "../models/settings.js";
import { SettingsStore } from "../store/settings.js";
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
import { exportModule } from "../tools/export.js";
import { createSkillsModule } from "../tools/skills.js";
import { createChatsModule, CHAT_TOOLS } from "../tools/chats.js";
import { createMemoryModule } from "../tools/memory.js";
import { cronModule } from "../tools/cron.js";
import { filesModule } from "../tools/files.js";
import { notifyModule } from "../tools/notify.js";
import { sqlModule } from "../tools/sql.js";
import { createBuildsModule } from "../tools/builds.js";
import { sitesModule } from "../tools/sites.js";
import { systemsModule } from "../tools/systems.js";
import { tasksModule } from "../tools/tasks.js";
import {
  assembleSystemPrompt,
  channelGuidance,
  inferScopeTags,
} from "./context.js";
import { GuardedTools } from "./guarded.js";
import { ProgressBus } from "./progress.js";
import { parseMentions } from "./mentions.js";
import { readFile as readWorkspaceFile } from "./files.js";
import { summarizeAction } from "@kos/shared";
import { attachmentBlocks, type Attachment } from "./attachments.js";
import { ensureProfile, type Profile } from "./profile.js";
import {
  RETENTION_KEY,
  SessionStore,
  primarySessionId,
  type Retention,
} from "./session.js";
import { ConversationStore, type Conversation } from "./conversations.js";
import {
  parseChatCommand,
  runChatCommand,
  touchesHistory,
  type ChatCommand,
  type CommandResult,
} from "./chatcommands.js";
import { compactHistory } from "./compact.js";

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

/** Owner settings for build sub-agents. */
export const BUILD_SETTINGS_KEY = "builds";

/**
 * Prefix on a queued action that belongs to a build sub-agent rather than to
 * the tool registry. See approve(): these are decisions, not calls.
 */
const BUILD_ACTION_PREFIX = "build.";

/** The orchestrator's own conversation id. */
export function orchestratorId(ownerId = "owner"): string {
  return `orchestrator:${ownerId}`;
}

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

/**
 * The orchestrator's reach, applied per turn rather than stored on the
 * conversation: it is a property of what the orchestrator is, so an edit to
 * the conversation cannot drift it, and it holds for workspaces that predate
 * it. The chats.* tools are restricted and arrive separately as a grant.
 */
const ORCHESTRATOR_SCOPE = ["memory"];

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
  readonly spend: SpendStore;
  readonly pending: PendingMessages;
  readonly builds: BuildRegistry;
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
  readonly conversations: ConversationStore;
  readonly facts: FactsStore;
  readonly settings: SettingsStore;
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
  /** The conversation currently running a turn, for memory attribution. */
  currentConversationId: string | undefined;

  /**
   * Conversations with a turn in flight right now.
   *
   * A set rather than a single id: a dispatched turn runs inside the
   * dispatcher's slot, so both are genuinely working. Read by the dashboard so
   * a thread can say it is thinking instead of looking idle for ten seconds.
   */
  private readonly working = new Set<string>();

  /** Conversations the owner has asked to stop, cleared when the turn ends. */
  private readonly stopping = new Set<string>();

  /** Turn progress, for readers watching a conversation as it runs. */
  readonly progress = new ProgressBus();

  private constructor(args: {
    workspace: Workspace;
    secrets: SecretsRegistry;
    registry: ToolRegistry;
    manifest: ProjectManifest;
    migrator: Migrator;
    config: InstanceConfig;
    pages: PageStore;
    crons: CronStore;
    spend: SpendStore;
    pending: PendingMessages;
    builds: BuildRegistry;
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
    conversations: ConversationStore;
    facts: FactsStore;
    settings: SettingsStore;
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
    this.spend = args.spend;
    this.pending = args.pending;
    this.builds = args.builds;
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
    this.conversations = args.conversations;
    this.facts = args.facts;
    this.settings = args.settings;
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
    const approvals = new ApprovalQueue(workspace.db, secrets);
    const spend = new SpendStore(workspace.db);
    const pending = new PendingMessages(workspace.db);
    const builds = new BuildRegistry();
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
      // Always wired. Without a channel this used to be absent, so `notify`
      // threw and every unattended job that ended in "tell me" lost its
      // message. The fallback puts it where the owner already looks.
      notify: async (text: string) => {
        if (options.notify) {
          await options.notify(text);
          return;
        }
        kernelRef?.recordNotice(text);
      },
    };

    const modules: KosModule[] = [
      filesModule,
      sqlModule,
      notifyModule,
      cronModule,
      createHttpModule({ allowedHosts: options.allowedHosts ?? [] }),
      createSearchModule(),
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
      createSkillsModule(promoter),
      createMemoryModule({
        facts,
        ownerId: profile.ownerId,
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
    // Renamed in place: it was called Command, which named the keystroke
    // rather than the thing, and a workspace that predates the rename should
    // not keep the old label forever.
    if (existing && existing.title === "Command") {
      conversations.rename(orchestrator, "KOS");
    }
    if (!existing) {
      conversations.create({
        id: orchestrator,
        userId: profile.ownerId,
        title: "KOS",
        brief: ORCHESTRATOR_BRIEF,
      });
    }

    const settings = new SettingsStore(workspace.db);
    // Retention the owner set, applied before any turn reads history, so a
    // restart does not quietly go back to the defaults.
    const retention = settings.get<Partial<Retention>>(RETENTION_KEY);
    if (retention) sessions.configure(retention);
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
      settings,
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
    return kernelRef;
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
      /** Surface this turn arrived on, so the reply can be shaped for it. */
      channel?: string;
      /**
       * Restricted tools granted for this turn. Only the orchestrator passes
       * these; an ordinary conversation cannot reach them.
       */
      grant?: string[];
      /**
       * Overrides the conversation's own tool scope for this turn. The
       * orchestrator uses it so its reach is a property of what it is rather
       * than stored state that an edit could drift away from.
       */
      allow?: string[];
      /** Files the owner attached to this message. */
      attachments?: Attachment[];
    } = {},
  ): Promise<HandleResult> {
    if (this.killSwitch.halted) {
      return { reply: "KOS is halted (kill switch engaged).", halted: true };
    }
    const userId = opts.userId ?? this.profile.ownerId;
    const sessionId =
      opts.sessionId ?? `chat:${userId}`;

    // A turn runs one at a time, so a second message waits. It is parked
    // where a reload can find it rather than living only in the browser: the
    // session history cannot be used for that, because the turn already
    // running rewrites it wholesale when it lands and would take the waiting
    // message with it.
    const useSession = !this.sessionless && !opts.noSession;
    const parked =
      useSession && this.queue.depth > 0
        ? this.pending.add(sessionId, text, opts.attachments ?? [])
        : undefined;

    return this.queue.enqueue(() => {
      if (parked !== undefined) this.pending.take(parked);
      return this.runTurn(text, userId, sessionId, opts);
    });
  }

  /**
   * One turn, without the queue.
   *
   * handleMessage wraps this in the serial queue. Dispatch calls it directly,
   * because a dispatched turn already runs inside the dispatcher's queue slot:
   * enqueuing again would wait on a task that is waiting on it.
   */
  private async runTurn(
    text: string,
    userId: string,
    sessionId: string,
    opts: {
      scopeTags?: string[];
      noSession?: boolean;
      origin?: "owner" | "system";
      channel?: string;
      grant?: string[];
      allow?: string[];
      attachments?: Attachment[];
    },
  ): Promise<HandleResult> {
    {
      const runId = this.runs.start("chat");
      const previousConversation = this.currentConversationId;
      this.currentConversationId = sessionId;
      this.working.add(sessionId);
      this.progress.emit({ kind: "turn-start", conversationId: sessionId });
      try {
        // A conversation may be a scoped agent: its own brief, its own reach.
        const conversation = this.conversations.get(sessionId);
        const inferred = opts.scopeTags ?? inferScopeTags(text);
        const scopeTags = this.accumulateScope(sessionId, inferred);
        const tools = this.guardedTools({
          userId,
          conversationId: sessionId,
          ...(scopeTags.length ? { scopeTags } : {}),
          // null is unrestricted; an array is the exact scope, empty included.
          // An explicit override wins: it says what this caller is, and the
          // conversation's own scope is what the owner set for ordinary turns.
          ...(opts.allow !== undefined
            ? { allow: opts.allow }
            : conversation?.toolAllow !== null &&
                conversation?.toolAllow !== undefined
              ? { allow: conversation.toolAllow }
              : {}),
          ...(opts.grant?.length ? { grant: opts.grant } : {}),
        });

        const recall = await this.memoryRetriever.recall(userId, text, {
          factLimit: 10,
          episodeLimit: 4,
          minFactsBeforeVector: 2,
        });
        // Pinned entries are the handful of things every conversation should
        // know without having to match them, so they bypass retrieval.
        const pinnedFacts = this.facts.pinned(userId);
        recall.facts = [
          ...pinnedFacts,
          ...recall.facts.filter((f) => !pinnedFacts.some((p) => p.key === f.key)),
        ];
        // A mention is a promise that the thing named is to hand. Resolved
        // here so the agent gets the file's contents or the page's spec
        // rather than a string it has to go and look up, and so a name that
        // no longer exists says so instead of being silently ignored.
        const mentioned = this.resolveMentions(text);
        const formatting = channelGuidance(opts.channel);
        // Say when the toolkit has been narrowed. Withheld tools are simply
        // absent, so a scoped agent asked for something outside its reach does
        // not know the capability exists: it cannot say "not here", and works
        // the only tools it has instead. One asked to alter a schema with a
        // files-and-memory scope spent its whole turn writing and deleting
        // memory entries, including a false one saying the change was made.
        // Only for a scope the owner set on the conversation. A per-turn
        // override is a caller that knows what it is and has a brief saying
        // what to do instead: the orchestrator read the generic note, said it
        // had no page tools, and stopped, when handing the work to another
        // conversation was the whole job.
        const scopeNote = opts.allow === undefined ? tools.scopeNote() : null;
        // The scope goes last, after the brief: a brief tells the agent what
        // it is for, and the two conflict exactly when the owner asks for
        // something the brief covers and the scope does not.
        const extra = [formatting, mentioned, conversation?.brief, scopeNote]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join("\n\n");
        const system = assembleSystemPrompt({
          baseSystem: this.system,
          profile: this.profile,
          projects: this.manifest.list(),
          recall,
          ...(extra ? { extra } : {}),
        });

        // Attachments ride on the turn's own message rather than the system
        // prompt, so a later turn replaying the transcript still has them.
        const userContent: ContentBlock[] = [
          { type: "text", text },
          ...attachmentBlocks(opts.attachments ?? []),
        ];
        let input: string | ModelMessage[] = text;
        const useSession = !this.sessionless && !opts.noSession;
        if (useSession) {
          const prior = this.sessions.historyForPrompt(sessionId);
          input = [...prior, { role: "user", content: userContent }];
          // Written before the model is asked anything.
          //
          // Recorded only at the end, what the owner said existed nowhere but
          // the browser for the length of the turn: reloading the page lost
          // it, and so would the process dying mid-answer. The reply is
          // appended when it arrives.
          this.sessions.record(sessionId, input);
          this.conversations.touch(
            sessionId,
            ...(opts.origin === "system" ? [] : [text]),
          );
        } else if (userContent.length > 1) {
          input = [{ role: "user", content: userContent }];
        }

        const result = await runAgent(this.inference, tools, input, {
          system,
          // Watched turns stream. A reader was shown one static word for the
          // whole of a turn, and with a reasoning model most of that time is
          // the model working rather than any tool running.
          shouldStop: () => this.stopping.has(sessionId),
          onDelta: (delta) =>
            this.progress.emit({
              kind: "delta",
              conversationId: sessionId,
              of: delta.kind,
              text: delta.text,
            }),
        });

        if (useSession) {
          // Persist the loop's own message list so tool calls and their results
          // survive into the next turn, not just the final text.
          this.sessions.record(sessionId, result.messages);
          // The conversation moved either way, and a reader watching it needs
          // to see that. Only the auto-title is withheld from a resume prompt,
          // which is harness plumbing and must not rename anything.
          this.conversations.touch(
            sessionId,
            ...(opts.origin === "system" ? [] : [text]),
          );
        }

        // Memory write path (salience) + episodic note for the exchange. Only
        // owner turns are remembered; harness-generated turns are plumbing.
        // Awaited so a write cannot be lost when the process exits right after
        // a reply, and so failures surface in the runs log instead of vanishing.
        // A turn that ends on a tool call has no text in it. Handed straight
        // to the reader that is silence: the agent looks like it ignored them.
        // It happens when the loop hits its iteration cap, which is exactly
        // when the reader most needs to hear that it got stuck.
        const reply =
          result.stopped && result.finalText.trim() === ""
            ? "Stopped."
            : result.finalText.trim() !== ""
              ? result.finalText
              : result.exhausted
                ? "I got stuck on that and stopped after too many steps without reaching an answer. Tell me what to try instead, or narrow it down."
                : "I do not have anything to add to that.";

        if (opts.origin !== "system") {
          await this.rememberExchange(userId, text, reply);
        }

        this.runs.finish(runId, "ok");
        return {
          reply,
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
      } finally {
        // Restored rather than cleared: a dispatched turn runs inside another,
        // and the outer one still has work to attribute.
        this.currentConversationId = previousConversation;
        this.working.delete(sessionId);
        this.stopping.delete(sessionId);
        this.progress.emit({ kind: "turn-end", conversationId: sessionId });
      }
    }
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

    /*
     * A build's permission request is a decision, not a call to make here.
     *
     * Builds queue their tool requests as build.Bash, build.Read and so on.
     * Those are not registered tools: the sub-agent performs the action itself
     * the moment it sees the row flip to approved. Executing them here looked
     * up a tool that does not exist, recorded "unknown tool: build.Bash" in the
     * audit log, and then resumed the parent agent with outcome=FAILED,
     * telling it the thing it had just watched succeed had failed.
     */
    if (action.tool.startsWith(BUILD_ACTION_PREFIX)) {
      const wanted = action.tool.slice(BUILD_ACTION_PREFIX.length);
      this.audit.record({
        tool: action.tool,
        args: stored,
        result: `approved; the build runs ${wanted} itself`,
        isError: false,
        riskTier: "risky",
        userId: decidedBy ?? this.profile.ownerId,
      });
      // No resume turn either. The build is not a conversation waiting on a
      // tool result; it is a process that was blocked and is now unblocked.
      return { ok: true, message: `Approved. The build continues with ${wanted}.` };
    }

    // Approvals arrive whenever the owner taps a button, so the execution has
    // to join the serial queue like any other job. Running it inline races
    // whatever is already in flight: two git snapshots in one repo, or a cron
    // job's read-modify-write interleaved across an await.
    //
    // Only the execution is enqueued. The resume turn below goes through
    // handleMessage, which enqueues itself; nesting would wait on a chain that
    // includes this very task and deadlock.
    const result = await this.queue.enqueue(async () => {
      /*
       * The approved call belongs to the conversation that asked for it.
       *
       * currentConversationId was only ever set inside runTurn, so a tool
       * executed from an approval ran with none. Anything that asks which
       * conversation it is working for got nothing: a build started this way
       * was orphaned from its own chat, so its permission requests carried no
       * conversation and its progress was emitted for nobody. The chat that
       * started it showed the request go out and then nothing at all.
       */
      const previous = this.currentConversationId;
      if (action.conversationId) this.currentConversationId = action.conversationId;
      let r;
      try {
        r = await this.registry.execute(
          action.tool,
          injectSecrets(stored, this.secrets),
        );
      } finally {
        this.currentConversationId = previous;
      }
      this.audit.record({
        tool: action.tool,
        args: stored,
        result: r.content,
        isError: r.isError,
        riskTier: "risky",
        userId: decidedBy ?? this.profile.ownerId,
      });
      // cron.schedule is risky, so this is the path a scheduled job normally
      // takes: approved here, never through the guarded executor.
      if (!r.isError) this.afterToolRan(action.tool);
      return r;
    });

    const userId = decidedBy ?? this.profile.ownerId;
    // Resume the conversation that asked. Resuming the primary one left the
    // waiting agent still waiting, and put the result in front of the wrong
    // reader.
    const sessionId =
      action.conversationId ?? primarySessionId(this.profile.ownerId);
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
    // As with approve: the build sees the decision itself and adapts. Resuming
    // the parent conversation would tell an agent that is not waiting on
    // anything that something it never asked for was refused.
    if (denied.tool.startsWith(BUILD_ACTION_PREFIX)) {
      const wanted = denied.tool.slice(BUILD_ACTION_PREFIX.length);
      return {
        ok: true,
        message: `Declined. The build was told it may not ${wanted}.`,
      };
    }
    const sessionId =
      denied.conversationId ?? primarySessionId(this.profile.ownerId);
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

  /**
   * A turn with the orchestrator. It runs in its own conversation and is the
   * only caller granted the chats.* tools, so the ability to read across
   * threads and start new ones exists in exactly one place.
   */
  async handleOrchestratorTurn(
    text: string,
    opts: { channel?: string; attachments?: Attachment[] } = {},
  ): Promise<HandleResult & { conversationId: string }> {
    const id = orchestratorId(this.profile.ownerId);
    const res = await this.handleMessage(text, {
      sessionId: id,
      userId: this.profile.ownerId,
      grant: [...CHAT_TOOLS],
      allow: [...ORCHESTRATOR_SCOPE],
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    });
    return { ...res, conversationId: id };
  }

  /**
   * Run a turn inside another conversation and return what it said.
   *
   * This is how the orchestrator delegates rather than merely filing work:
   * the sub-agent runs with its own brief and its own tool scope, and its
   * reply comes back so the orchestrator can report a result instead of a
   * promise that something was created.
   *
   * Bypasses the queue on purpose. The caller is already holding the queue
   * slot, so nothing else is running concurrently, and enqueuing here would
   * deadlock against the very task doing the dispatching.
   */
  async dispatchTo(
    conversationId: string,
    text: string,
  ): Promise<{ reply: string; conversationId: string }> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`no such conversation: ${conversationId}`);
    // The sub-agent is never granted the chats tools, so a dispatched turn
    // cannot dispatch again and there is no recursion to bound.
    const res = await this.runTurn(text, conversation.userId, conversation.id, {
      channel: "dispatch",
    });
    return { reply: res.reply, conversationId: conversation.id };
  }

  clearSession(sessionId: string): void {
    this.sessions.clear(sessionId);
    this.sessionScope.delete(sessionId);
  }

  /**
   * Which conversation a surface should use for this turn.
   *
   * A surface with native threads passes its thread id as `conversationKey`
   * and gets one conversation per thread, created on first sight. A surface
   * with a single stream (a DM, the CLI) has no key, so it follows a pointer
   * the user moves with `/switch`.
   */
  conversationFor(
    channel: string,
    userId: string,
    conversationKey?: string,
  ): Conversation {
    if (conversationKey) {
      const id = `${channel}:${conversationKey}`;
      return (
        this.conversations.get(id) ??
        this.conversations.create({ id, userId, channel })
      );
    }

    const active = this.conversations.activeFor(channel, userId);
    if (active) return this.conversations.get(active)!;

    // Fall back to the most recent conversation, else the primary one.
    const existing = this.conversations.list(userId)[0];
    const chosen =
      existing ??
      this.conversations.create({
        id: primarySessionId(userId),
        userId,
        channel,
        title: "Main",
      });
    this.conversations.setActive(channel, userId, chosen.id);
    return chosen;
  }

  /**
   * One turn from a messaging surface: resolve the conversation, run a
   * conversation command if that is what it was, otherwise run the agent.
   * Channels call this instead of handleMessage so every surface gets the same
   * conversation behaviour without implementing any of it.
   */
  /**
   * `/compact` and `/clear`: the two commands that act on a conversation's
   * history rather than on the list of conversations.
   *
   * They live here rather than in the command table because that table is pure
   * bookkeeping over the conversation store, and compacting needs the session
   * history and a model call.
   */
  async runHistoryCommand(
    command: ChatCommand,
    conversationId: string,
  ): Promise<string> {
    const history = this.sessions.get(conversationId);

    if (command.kind === "clear") {
      if (history.length === 0) return "Nothing to forget; this chat is empty.";
      this.sessions.clear(conversationId);
      // Careful about what this actually promises. Clearing drops the
      // transcript, not anything saved to memory, and saved facts are recalled
      // into later turns: the first version of this said "I no longer remember
      // what was in it" and was then able to recite a fact from the cleared
      // chat, which is a worse answer than saying nothing.
      return [
        `Forgotten ${history.length} message${history.length === 1 ? "" : "s"} of this chat's history.`,
        "Anything saved to memory stays, and I will still recall it. Knowledge lists those.",
      ].join(" ");
    }

    if (history.length === 0) return "Nothing to compact; this chat is empty.";
    const result = await compactHistory(this.inference, history);
    if (!result) {
      return "Not enough here to be worth compacting yet.";
    }
    this.sessions.set(conversationId, result.messages);
    return [
      `Compacted ${result.compacted} messages into a summary. Here is what I kept:`,
      "",
      result.summary,
    ].join("\n");
  }

  /**
   * Run a slash command against a conversation named outright, as the
   * dashboard names it, rather than resolved from a channel and a sender.
   *
   * Returns null when the text is not a command, so a caller can fall through
   * to an ordinary turn. The dashboard had no command path at all: it offered
   * the commands in its autocomplete and then posted them to the model as
   * prose, which answered them by improvising. Same verbs, same behaviour,
   * whichever surface you type them on.
   */
  async runCommandIn(
    conversationId: string,
    userId: string,
    text: string,
    channel = "dashboard",
  ): Promise<(HandleResult & { isCommand: true; switchedTo?: string }) | null> {
    const command = parseChatCommand(text);
    if (!command) return null;

    if (touchesHistory(command)) {
      const reply = await this.runHistoryCommand(command, conversationId);
      return { reply, halted: false, isCommand: true };
    }

    const result = runChatCommand(command, {
      conversations: this.conversations,
      channel,
      userId,
      currentId: conversationId,
    });
    return {
      reply: result.reply,
      halted: false,
      isCommand: true,
      ...(result.switchedTo ? { switchedTo: result.switchedTo } : {}),
    };
  }

  async handleChannelTurn(input: {
    text: string;
    userId: string;
    channel: string;
    conversationKey?: string;
    attachments?: Attachment[];
  }): Promise<HandleResult & { conversationId: string; isCommand: boolean }> {
    const conversation = this.conversationFor(
      input.channel,
      input.userId,
      input.conversationKey,
    );

    const command = parseChatCommand(input.text);
    if (command && touchesHistory(command)) {
      const result = await this.runHistoryCommand(command, conversation.id);
      return {
        reply: result,
        halted: false,
        conversationId: conversation.id,
        isCommand: true,
      };
    }
    if (command) {
      // Commands are bookkeeping: no model call, no queue, no transcript entry.
      const result: CommandResult = runChatCommand(command, {
        conversations: this.conversations,
        channel: input.channel,
        userId: input.userId,
        currentId: conversation.id,
      });
      return {
        reply: result.reply,
        halted: false,
        conversationId: result.switchedTo ?? conversation.id,
        isCommand: true,
      };
    }

    const res = await this.handleMessage(input.text, {
      userId: input.userId,
      sessionId: conversation.id,
      channel: input.channel,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    return { ...res, conversationId: conversation.id, isCommand: false };
  }

  /**
   * Context for a self_prompt cron run: the same profile, manifest, and salient
   * memory a chat turn gets. Unattended jobs previously ran with no system
   * prompt at all, so the agent woke with no identity and no project context.
   */
  private async cronSystemPrompt(job: CronJob): Promise<string> {
    const query = job.prompt ?? job.name;
    const recall = await this.memoryRetriever.recall(this.profile.ownerId, query, {
      factLimit: 10,
      episodeLimit: 4,
    });
    return assembleSystemPrompt({
      baseSystem: this.system,
      profile: this.profile,
      projects: this.manifest.list(),
      recall,
      extra: [
        "## Scheduled run",
        `You are running unattended as cron job "${job.name}".`,
        "There is no one to ask, so do not ask questions.",
        "Risky actions still queue for approval; say what you queued and stop.",
      ].join("\n"),
    });
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
    /** The conversation this turn belongs to, for approval routing. */
    conversationId?: string;
    /** Hard allow-list from the conversation, when it is a scoped agent. */
    allow?: string[];
    /** Restricted tools granted for this turn. */
    grant?: string[];
  } = {}): GuardedTools {
    return new GuardedTools({
      registry: this.registry,
      secrets: this.secrets,
      audit: this.audit,
      approvals: this.approvals,
      userId: opts.userId ?? this.profile.ownerId,
      toolLimit: 48,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      ...(opts.scopeTags ? { scopeTags: opts.scopeTags } : {}),
      ...(opts.allow !== undefined ? { allow: opts.allow } : {}),
      ...(opts.grant?.length ? { grant: opts.grant } : {}),
      ...(this.onApprovalRequested
        ? { onQueued: this.onApprovalRequested }
        : {}),
      onExecuted: (tool, result) => {
        this.afterToolRan(tool);
        if (opts.conversationId) {
          this.progress.emit({
            kind: "tool-end",
            conversationId: opts.conversationId,
            tool,
            isError: result.isError === true,
            // Capped: a live call should be openable like a finished one, and
            // a tool that returns a megabyte should not be sent down an
            // event stream to say so.
            ...(typeof result.content === "string"
              ? { result: result.content.slice(0, 4000) }
              : {}),
          });
        }
      },
      onStarted: (tool, input) => {
        if (!opts.conversationId) return;
        this.progress.emit({
          kind: "tool-start",
          conversationId: opts.conversationId,
          tool,
          summary: summarizeAction(tool, input),
          input,
        });
      },
    });
  }

  /**
   * State a tool changed that lives outside the database.
   *
   * The scheduler holds node-cron tasks in memory, built from the crons table
   * when the host started. A job the agent scheduled after that was stored,
   * enabled, and never once fired, because nothing told the scheduler it
   * existed. The dashboard's own enable and delete already reloaded; the
   * agent's path did not.
   */
  private afterToolRan(tool: string): void {
    if (tool.startsWith("cron.")) this.reloadCron();
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
              // The job's query and condition are reads that build the
              // variable scope, so they run on the read-only handle. Writes
              // belong in the job's actions, which go through the guarded
              // tool path and its risk tiers.
              db: this.workspace.reader,
              tools: this.guardedTools(),
              inference: this.inference,
              buildSystem: (j) => this.cronSystemPrompt(j),
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

  /**
   * An agent-initiated message with no channel to carry it.
   *
   * It lands in the owner's primary conversation, which is the same thread the
   * CLI and a DM use, so unattended work is readable in Chats rather than
   * thrown away with "no notify channel is wired".
   */
  recordNotice(text: string): void {
    const sessionId = primarySessionId(this.profile.ownerId);
    // record() replaces the transcript, so the existing one comes with it.
    this.sessions.record(sessionId, [
      ...this.sessions.get(sessionId),
      { role: "assistant", content: [{ type: "text", text }] },
    ]);
    this.conversations.touch(sessionId);
  }

  /**
   * Which model is actually answering, when the inference layer can say.
   *
   * The routing table is picked from whichever API keys are present, so a
   * workspace with only one provider gets a materially different agent from
   * the default and nothing anywhere said so.
   */
  routes(): Record<string, RouteSummary> | undefined {
    const source = this.inference as {
      describeRoutes?: () => Record<string, RouteSummary>;
    };
    return source.describeRoutes?.();
  }

  /**
   * Re-read secrets from the environment after the owner has changed them.
   *
   * The registry is updated in place rather than replaced, because the router
   * and every tool that injects a secret hold a reference to this one: handing
   * out a new object would leave them all pointing at the old keys until a
   * restart, which is exactly what saving from the dashboard is meant to avoid.
   */
  reloadSecrets(): void {
    const fresh = SecretsRegistry.fromEnv();
    for (const name of this.secrets.names()) {
      if (!fresh.has(name)) this.secrets.remove(name);
    }
    for (const name of fresh.names()) {
      this.secrets.set(name, fresh.require(name));
    }
  }

  /** Repoint the router at the owner's saved choices, without a restart. */
  applyModelSettings(settings: ModelSettings): void {
    const router = this.inference as { setRoute?: unknown; routeFor?: unknown };
    if (typeof router.setRoute !== "function") return;
    applyModelSettings(this.inference as Parameters<typeof applyModelSettings>[0], settings);
  }

  /**
   * Models this provider will actually accept, asked at call time rather than
   * kept in a list here. A hard-coded list is how the OpenAI route sat on
   * gpt-4o long after better models existed.
   */
  async availableModels(): Promise<string[]> {
    const route = this.routes()?.["reasoning"];
    if (route?.provider !== "openai") return [];
    const key = this.secrets.get("openai");
    if (!key) return [];
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`model list failed: ${res.status}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(gpt|o[0-9])/.test(id))
      .filter((id) => !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
      .sort();
  }

  /**
   * Ask a running turn to stop at its next round trip.
   *
   * Between round trips rather than mid-call: a tool that is already running
   * has to finish or its result is lost, and the model's own reply arrives in
   * one piece.
   */
  stop(sessionId: string): boolean {
    if (!this.working.has(sessionId)) return false;
    this.stopping.add(sessionId);
    return true;
  }


  /**
   * Turn the @references in a message into context.
   *
   * Only what was actually named: this is the owner pointing at something, so
   * it is worth the prompt space, unlike everything else in the workspace.
   */
  private resolveMentions(text: string): string | null {
    const refs = parseMentions(text);
    if (refs.length === 0) return null;

    const parts: string[] = [];
    for (const ref of refs) {
      if (ref.kind === "project") {
        const project = this.manifest.get(ref.id);
        parts.push(
          project
            ? `Project ${project.slug} (${project.type}): ${project.description ?? "no description"}`
            : `Project ${ref.id}: not found.`,
        );
        continue;
      }
      if (ref.kind === "page") {
        const page = this.pages.get(ref.id);
        parts.push(
          page
            ? `Page ${ref.id} in project ${page.record.projectSlug}:\n${JSON.stringify(page.spec, null, 2)}`
            : `Page ${ref.id}: not found.`,
        );
        continue;
      }
      if (ref.kind === "schedule") {
        const job = this.crons.list().find((c) => c.name === ref.id);
        parts.push(
          job
            ? `Schedule ${job.name}: ${job.schedule}, type ${job.type}, ${job.enabled ? "enabled" : "disabled"}`
            : `Schedule ${ref.id}: not found.`,
        );
        continue;
      }
      try {
        const file = readWorkspaceFile(this.workspace, ref.id);
        parts.push(
          file.text === undefined
            ? `File ${ref.id}: not shown (${file.omitted ?? "unreadable"}).`
            : `File ${ref.id}:\n${file.text}`,
        );
      } catch (err) {
        parts.push(
          `File ${ref.id}: ${err instanceof Error ? err.message : "could not be read"}`,
        );
      }
    }
    return ["## Referenced by the owner in this message", ...parts].join("\n\n");
  }


  /** Conversation ids with a turn in flight, for the chat list. */
  busyConversations(): string[] {
    return [...this.working];
  }

  /**
   * Drop everything from the owner's Nth message onward, and optionally say it
   * differently.
   *
   * Retry, edit and fork are the same operation seen from three angles: rewind
   * the transcript to a point and run from there. Fork copies first, so the
   * original survives; the other two rewrite in place.
   */
  /**
   * Take a waiting message into a conversation of its own.
   *
   * The chat as it stands is copied, the message is removed from the queue and
   * asked in the copy, and the original carries on with whatever else was
   * behind it. This is for the follow-up you typed while it was working and
   * then decided was really a different thread.
   */
  async forkPending(waiting: PendingMessage): Promise<string> {
    const source = this.conversations.get(waiting.conversationId);
    if (!source) throw new Error("that conversation no longer exists");

    const fork = this.conversations.create({
      userId: source.userId,
      title: `${source.title} (fork)`,
      ...(source.brief ? { brief: source.brief } : {}),
      ...(source.toolAllow !== null ? { toolAllow: source.toolAllow } : {}),
    });
    // A snapshot of the history as it is now. The turn still running in the
    // original will write its own result there and not here.
    this.sessions.set(fork.id, this.sessions.get(waiting.conversationId));
    this.conversations.touch(fork.id);

    // Claimed before it is asked, so it cannot also run in the original.
    this.pending.remove(waiting.id);
    void this.handleMessage(waiting.text, {
      sessionId: fork.id,
      userId: source.userId,
      ...(waiting.attachments.length ? { attachments: waiting.attachments } : {}),
    });
    return fork.id;
  }

  async rewind(
    sessionId: string,
    userTurnIndex: number,
    opts: { text?: string; forkTitle?: string } = {},
  ): Promise<HandleResult & { conversationId: string }> {
    const source = this.conversations.get(sessionId);
    if (!source) throw new Error(`no such conversation: ${sessionId}`);

    const history = this.sessions.get(sessionId);
    // Owner turns are the anchors: a tool result is also a "user" message on
    // the wire, so only messages carrying text count as something they said.
    const anchors: number[] = [];
    history.forEach((m, i) => {
      if (m.role !== "user") return;
      if (!m.content.some((b) => b.type === "text" || b.type === "file" || b.type === "image")) {
        return;
      }
      anchors.push(i);
    });
    const at = anchors[userTurnIndex];
    if (at === undefined) throw new Error(`no message #${userTurnIndex} to rewind to`);

    const original = history[at];
    const said =
      opts.text ??
      original?.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("") ??
      "";
    if (!said.trim()) throw new Error("nothing to send");

    // Anything the original message carried travels with it, so a retry of a
    // message with a picture is still about the picture.
    const carried = (original?.content ?? []).filter(
      (b) => b.type === "image" || b.type === "file",
    );

    // A fork is a copy, not a rerun: the answer already exists, so producing
    // it again costs a model call and can come back different, which is not
    // what "fork this conversation" means.
    if (opts.forkTitle !== undefined && opts.text === undefined) {
      const fork = this.conversations.create({
        userId: source.userId,
        title: opts.forkTitle || `${source.title} (fork)`,
        ...(source.brief ? { brief: source.brief } : {}),
        ...(source.toolAllow !== null ? { toolAllow: source.toolAllow } : {}),
      });
      this.sessions.set(fork.id, history);
      this.conversations.touch(fork.id);
      return {
        reply: "",
        halted: false,
        sessionId: fork.id,
        conversationId: fork.id,
      };
    }

    let target = sessionId;
    if (opts.forkTitle !== undefined) {
      const fork = this.conversations.create({
        userId: source.userId,
        title: opts.forkTitle || `${source.title} (fork)`,
        ...(source.brief ? { brief: source.brief } : {}),
        ...(source.toolAllow !== null ? { toolAllow: source.toolAllow } : {}),
      });
      target = fork.id;
    }
    this.sessions.set(target, history.slice(0, at));

    const res = await this.handleMessage(said, {
      sessionId: target,
      userId: source.userId,
      ...(carried.length ? { attachments: [] } : {}),
    });
    // Re-attach by hand: handleMessage builds its own user message, and the
    // carried blocks are already decoded rather than base64 payloads.
    if (carried.length) {
      const after = this.sessions.get(target);
      const idx = after.findIndex(
        (m, i) => i >= at && m.role === "user" && m.content.some((b) => b.type === "text"),
      );
      if (idx >= 0) {
        after[idx] = { role: "user", content: [...after[idx]!.content, ...carried] };
        this.sessions.set(target, after);
      }
    }
    return { ...res, conversationId: target };
  }

  reloadCron(): void {
    this.scheduler?.reload();
  }

  /** Jobs the running scheduler actually holds, as opposed to rows in the table. */
  scheduledCronCount(): number {
    return this.scheduler?.scheduledCount() ?? 0;
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
