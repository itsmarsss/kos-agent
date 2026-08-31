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
import { exportModule } from "../tools/export.js";
import { createSkillsModule } from "../tools/skills.js";
import { createChatsModule, CHAT_TOOLS } from "../tools/chats.js";
import { createMemoryModule } from "../tools/memory.js";
import { cronModule } from "../tools/cron.js";
import { filesModule } from "../tools/files.js";
import { notifyModule } from "../tools/notify.js";
import { sqlModule } from "../tools/sql.js";
import { systemsModule } from "../tools/systems.js";
import { tasksModule } from "../tools/tasks.js";
import {
  assembleSystemPrompt,
  channelGuidance,
  inferScopeTags,
} from "./context.js";
import { GuardedTools } from "./guarded.js";
import { ensureProfile, type Profile } from "./profile.js";
import { SessionStore, primarySessionId } from "./session.js";
import { ConversationStore, type Conversation } from "./conversations.js";
import {
  parseChatCommand,
  runChatCommand,
  type CommandResult,
} from "./chatcommands.js";

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
  "Creating a conversation and stopping is not an outcome. Every reply should say what the agent actually did, not that you set something up.",
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
    conversations: ConversationStore;
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
    this.conversations = args.conversations;
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
    if (!conversations.get(orchestrator)) {
      conversations.create({
        id: orchestrator,
        userId: profile.ownerId,
        title: "Command",
        brief: ORCHESTRATOR_BRIEF,
      });
    }

    const inference =
      options.inference ?? createDefaultRouter(secrets);

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
    } = {},
  ): Promise<HandleResult> {
    if (this.killSwitch.halted) {
      return { reply: "KOS is halted (kill switch engaged).", halted: true };
    }
    const userId = opts.userId ?? this.profile.ownerId;
    const sessionId =
      opts.sessionId ?? `chat:${userId}`;

    return this.queue.enqueue(() => this.runTurn(text, userId, sessionId, opts));
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
    },
  ): Promise<HandleResult> {
    {
      const runId = this.runs.start("chat");
      const previousConversation = this.currentConversationId;
      this.currentConversationId = sessionId;
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
        const formatting = channelGuidance(opts.channel);
        // Say when the toolkit has been narrowed. Withheld tools are simply
        // absent, so a scoped agent asked for something outside its reach does
        // not know the capability exists: it cannot say "not here", and works
        // the only tools it has instead. One asked to alter a schema with a
        // files-and-memory scope spent its whole turn writing and deleting
        // memory entries, including a false one saying the change was made.
        const scopeNote = tools.scopeNote();
        // The scope goes last, after the brief: a brief tells the agent what
        // it is for, and the two conflict exactly when the owner asks for
        // something the brief covers and the scope does not.
        const extra = [formatting, conversation?.brief, scopeNote]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join("\n\n");
        const system = assembleSystemPrompt({
          baseSystem: this.system,
          profile: this.profile,
          projects: this.manifest.list(),
          recall,
          ...(extra ? { extra } : {}),
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
          result.finalText.trim() !== ""
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

    // Approvals arrive whenever the owner taps a button, so the execution has
    // to join the serial queue like any other job. Running it inline races
    // whatever is already in flight: two git snapshots in one repo, or a cron
    // job's read-modify-write interleaved across an await.
    //
    // Only the execution is enqueued. The resume turn below goes through
    // handleMessage, which enqueues itself; nesting would wait on a chain that
    // includes this very task and deadlock.
    const result = await this.queue.enqueue(async () => {
      const r = await this.registry.execute(
        action.tool,
        injectSecrets(stored, this.secrets),
      );
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
    opts: { channel?: string } = {},
  ): Promise<HandleResult & { conversationId: string }> {
    const id = orchestratorId(this.profile.ownerId);
    const res = await this.handleMessage(text, {
      sessionId: id,
      userId: this.profile.ownerId,
      grant: [...CHAT_TOOLS],
      allow: [...ORCHESTRATOR_SCOPE],
      ...(opts.channel ? { channel: opts.channel } : {}),
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
  async handleChannelTurn(input: {
    text: string;
    userId: string;
    channel: string;
    conversationKey?: string;
  }): Promise<HandleResult & { conversationId: string; isCommand: boolean }> {
    const conversation = this.conversationFor(
      input.channel,
      input.userId,
      input.conversationKey,
    );

    const command = parseChatCommand(input.text);
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
      onExecuted: (tool) => this.afterToolRan(tool),
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
