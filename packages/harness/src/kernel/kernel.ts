import { runAgent, type Inference } from "../agent/loop.js";
import { PressRoutes } from "../channels/presses.js";
import type { MessageButton, MessageCard } from "../channels/types.js";
import { DaemonStore } from "../daemons/store.js";
import { DaemonSupervisor } from "../daemons/supervisor.js";
import { ToolRegistry } from "../agent/registry.js";
import { type CronActionResult, runCronJob, type CronExecResult } from "../cron/executor.js";
import { CronStore } from "../cron/store.js";
import type { McpModule } from "../tools/mcp.js";
import { bootKernel } from "./boot.js";
import { CronService, type CronFireResult } from "./cronservice.js";
import { MemoryExtractor, type ExtractionReport } from "../memory/extractor.js";
import { MEMORY_JOB } from "../memory/job.js";
import type { ReviewQueue } from "../memory/review.js";
import type { Task } from "../models/router.js";
import type { Provider } from "../models/provider.js";
import { CUSTOM_PROVIDER, OpenAICompatibleProvider } from "../models/providers/compat.js";
import { CUSTOM_ENDPOINT_KEY, parseCustomEndpoint, type CustomEndpoint } from "../models/settings.js";
import type { CronJob } from "../cron/types.js";
import {
  FactsStore,
  MemoryRetriever,
  MemoryWriter,
  EventLog,
  type EmbeddingProvider,
} from "../memory/index.js";
import type { ContentBlock, ModelMessage } from "../models/types.js";
import { type RouteSummary } from "../models/router.js";
import { SpendStore } from "../ops/spend.js";
import { BuildRegistry } from "../builds/registry.js";
import { sitesBaseUrl } from "../sites/server.js";
import { PendingMessages, type PendingMessage } from "./pending.js";
import { applyModelSettings, type ModelSettings } from "../models/settings.js";
import { SettingsStore } from "../store/settings.js";
import { ModuleLoader, type KosModule, type LoadReport } from "../modules/loader.js";
import { AuditLog } from "../ops/audit.js";
import { ApprovalQueue, type PendingAction } from "../ops/approvals.js";
import { PersistentKillSwitch } from "../ops/killswitch.js";
import { priorForSdk, runSdkChat, type SdkChatResult } from "../chat/sdkchat.js";
import { HealthMonitor } from "../ops/health.js";
import { RunsLog } from "../ops/runs.js";
import { WorkQueue } from "../ops/queue.js";
import { WorkspaceBackup } from "../ops/backup.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { SkillPromoter, type PromoteInput, type PromoteOutcome } from "../skills/promote.js";
import { Workspace } from "../store/workspace.js";
import { InstanceConfig } from "../systems/config.js";
import { ProjectManifest } from "../systems/manifest.js";
import { describeActive } from "../systems/schema.js";
import { Migrator } from "../systems/migrate.js";
import { PageStore } from "../systems/pages.js";
import { PermissionStore } from "../ops/permissions.js";
import { offeredSkills, readSkills } from "../skills/manifest.js";
import { SKILLS_KEY, parseSkillSettings } from "../skills/settings.js";
import { CHAT_TOOLS } from "../tools/chats.js";
import { type NotifyPayload } from "../tools/notify.js";
import { Heartbeat, heartbeatBeat } from "./heartbeat.js";
import { AfterTurn } from "./afterturn.js";
import { Caretaker } from "./caretaker.js";
import { Decisions, type DecisionResult } from "./decisions.js";
import { assembleSystemPrompt, withoutTurnContext, channelGuidance } from "./context.js";
import { GuardedTools } from "./guarded.js";
import { ProgressBus } from "./progress.js";
import { BEHAVIOUR_KEY, parseBehaviour, type Behaviour } from "./behaviour.js";
import { parseMentions } from "./mentions.js";
import { readFile as readWorkspaceFile } from "./files.js";
import { summarizeAction } from "@kos/shared";
import { attachmentBlocks, type Attachment } from "./attachments.js";
import { type Profile } from "./profile.js";
import { SessionStore, cronSessionId } from "./session.js";
import { ConversationStore, type Conversation, projectConversationId } from "./conversations.js";
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
  notify?: (payload: NotifyPayload) => Promise<void>;
  /** Additional (e.g. agent-promoted or third-party) modules to load. */
  extraModules?: KosModule[];
  /** Hosts the http.fetch tool may reach. */
  /** A function is re-read per call, so a host added in Settings works now. */
  allowedHosts?: string[] | (() => string[]);
  profileOverrides?: Partial<Profile>;
  system?: string;
  /** Notified when a risky action is queued (e.g. to render Discord buttons). */
  onApprovalRequested?: (action: PendingAction) => void;
  /** Disable session history (tests). */
  sessionless?: boolean;
}

export type { CronFireResult } from "./cronservice.js";

export interface HandleResult {
  reply: string;
  halted: boolean;
  sessionId?: string;
}

/** How long a button KOS sent stays pressable. */
/** Owner settings for build sub-agents. */

export const BUILD_SETTINGS_KEY = "builds";
/** Set once the one-time retirement of pre-surface pointers has happened. */

/** The orchestrator's own conversation id. */
export function orchestratorId(ownerId = "owner"): string {
  return `orchestrator:${ownerId}`;
}

/**
 * The one thread a messaging surface talks in.
 *
 * A surface without native threads used to follow a movable pointer, so
 * "where does a Discord message go" was answered by whatever was pointed at
 * last -- invisible from the surface itself, and prone to drifting onto
 * whatever had been touched most recently. A surface gets one continuous
 * stream instead, the way the dashboard has one.
 */
export function surfaceSessionId(channel: string, ownerId = "owner"): string {
  return `${channel}:${ownerId}`;
}

/**
 * What the surface's own thread is, said to itself.
 *
 * Not a router: the owner asked for the full toolkit here, so it does the
 * work when the work is small and hands it on when it belongs somewhere
 * else. The chats tools are granted for exactly that second case.
 */
const SURFACE_BRIEF = [
  "This is the owner's continuous stream on this surface. Everything they say here arrives in this one thread, and everything you say goes back to them there.",
  "You have the full toolkit, so do small things here rather than making a conversation for each one.",
  "When a request belongs to work that already has its own conversation, or is big enough to want one, use the chats tools to find or create it and give it the task, then say in a line what it did.",
  "The owner can also ask to be routed somewhere explicitly. Take that as an instruction, not a suggestion.",
].join("\n");

/**
 * The orchestrator's reach, applied per turn rather than stored on the
 * conversation: it is a property of what the orchestrator is, so an edit to
 * the conversation cannot drift it, and it holds for workspaces that predate
 * it. The chats.* tools are restricted and arrive separately as a grant.
 */
const ORCHESTRATOR_SCOPE = ["memory"];

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
  readonly health: HealthMonitor;
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
  /** The log every exchange lands in; the ground truth under memory. */
  readonly events: EventLog;
  /** Where a button press belongs, for the surface that receives one. */
  readonly presses: PressRoutes;
  /** The agent's long-running programs, and what is keeping them up. */
  readonly daemons: DaemonStore;
  readonly supervisor: DaemonSupervisor;
  /** Holds the modules so what they opened can be let go at close. */
  private readonly loader: ModuleLoader;
  /** The servers behind mcp.* tools, so a module switched on can be brought up without a restart. */
  readonly mcp: McpModule;
  /** What the dream job left for the owner to decide. */
  readonly review: ReviewQueue;
  /** Noticing failures, telling the owner, and trying to fix them. */
  readonly caretaker: Caretaker;
  /** Carrying out approve and deny, including the recovery path for an orphaned action. */
  private readonly decisions: Decisions;
  /** Remembering and naming, once a turn has answered. */
  private readonly afterTurn: AfterTurn;
  /** Decisions the owner has made before, so the same shape stops asking. */
  readonly permissions: PermissionStore;
  readonly settings: SettingsStore;
  readonly memoryWriter: MemoryWriter;
  readonly memoryRetriever: MemoryRetriever;

  private readonly inference: Inference;
  private readonly system: string;
  private readonly onApprovalRequested?: (action: PendingAction) => void;
  private readonly sessionless: boolean;
  /** Scheduled jobs: when they run and what a run is on the record. */
  private readonly cron: CronService;
  /** Reads new conversation in the background and proposes claims. Off until the owner turns it on. */
  readonly extractor: MemoryExtractor;
  private heartbeat?: Heartbeat;
  /**
   * Scope tags accumulated per session. Inference reads only the latest
   * message, so a follow-up that happens to match no keyword would otherwise
   * drop the tools the conversation has been using. Scope only ever grows
   * within a session; clearing the session clears it.
   */
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

  /** Called by bootKernel, which assembles the args; not meant for anyone else. */
  constructor(args: {
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
    health: HealthMonitor;
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
    presses: PressRoutes;
    daemons: DaemonStore;
    supervisor: DaemonSupervisor;
    loader: ModuleLoader;
    mcp: McpModule;
    review: ReviewQueue;
    permissions: PermissionStore;
    settings: SettingsStore;
    memoryWriter: MemoryWriter;
    memoryRetriever: MemoryRetriever;
    embedder: EmbeddingProvider;
    events: EventLog;
    inference: Inference;
    system: string;
    sessionless: boolean;
    notify?: (payload: NotifyPayload) => Promise<void>;
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
    this.health = args.health;
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
    this.events = args.events;
    this.presses = args.presses;
    this.daemons = args.daemons;
    this.supervisor = args.supervisor;
    this.loader = args.loader;
    this.mcp = args.mcp;
    this.review = args.review;
    this.permissions = args.permissions;
    this.decisions = new Decisions({
      ownerId: args.profile.ownerId,
      approvals: args.approvals,
      permissions: args.permissions,
      conversations: args.conversations,
      audit: args.audit,
      registry: args.registry,
      secrets: args.secrets,
      queue: args.queue,
      inConversation: async (conversationId, work) => {
        const previous = this.currentConversationId;
        if (conversationId) this.currentConversationId = conversationId;
        try {
          return await work();
        } finally {
          this.currentConversationId = previous;
        }
      },
      onToolRan: (tool) => this.afterToolRan(tool),
      handleMessage: (text, opts) => this.handleMessage(text, opts),
    });
    this.caretaker = new Caretaker({
      ownerId: args.profile.ownerId,
      isClosed: () => this.closed,
      isHalted: () => this.killSwitch.halted,
      behaviour: () => this.behaviour(),
      health: args.health,
      ...(args.notify ? { notify: args.notify } : {}),
      sessions: args.sessions,
      conversations: args.conversations,
      crons: args.crons,
      manifest: args.manifest,
      handleMessage: (text, opts) => this.handleMessage(text, opts),
    });
    this.cron = new CronService({
      crons: args.crons,
      killSwitch: this.killSwitch,
      selfPromptsPerHour: () => this.behaviour().selfPromptsPerHour,
      enqueue: (work) => this.queue.enqueue(work),
      runs: args.runs,
      health: args.health,
      report: (key, label, ok, error) => this.caretaker.report(key, label, ok, error),
      backup: args.backup,
      run: (job) => this.runScheduledJob(job),
    });
    this.extractor = new MemoryExtractor({
      ownerId: args.profile.ownerId,
      events: args.events,
      facts: args.facts,
      inference: args.inference,
      settings: args.settings,
    });
    this.afterTurn = new AfterTurn({
      ownerId: args.profile.ownerId,
      isClosed: () => this.closed,
      runs: args.runs,
      facts: args.memoryWriter,
      embedder: args.embedder,
      events: args.events,
      conversations: args.conversations,
      inference: args.inference,
    });
    this.settings = args.settings;
    this.memoryWriter = args.memoryWriter;
    this.memoryRetriever = args.memoryRetriever;
    this.inference = args.inference;
    this.system = args.system;
    this.sessionless = args.sessionless;
    this.onApprovalRequested = args.onApprovalRequested;
  }

  /** Build a kernel over a workspace. What it is made of is in boot.ts. */
  static boot(options: KernelOptions): Promise<Kernel> {
    return bootKernel(options);
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
       * Room to work in, in model round-trips. The default suits a question
       * with a couple of lookups behind it; diagnosing a failure spends most
       * of its steps reading before it can change anything.
       */
      maxIterations?: number;
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
    // Behind this conversation's own work, not behind the whole process. A
    // turn in another chat used to park a message here for no reason the
    // owner could see.
    const parked =
      useSession && this.queue.depthOf(sessionId) > 0
        ? this.pending.add(sessionId, text, opts.attachments ?? [])
        : undefined;

    return this.queue.enqueue(() => {
      if (parked !== undefined) this.pending.take(parked);
      return this.runTurn(text, userId, sessionId, opts);
    }, sessionId);
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
      noSession?: boolean;
      origin?: "owner" | "system";
      channel?: string;
      grant?: string[];
      allow?: string[];
      attachments?: Attachment[];
      maxIterations?: number;
      /** Which model class answers; the reasoning route unless a job says cheap. */
      task?: Task;
    },
  ): Promise<HandleResult> {
    {
      const runId = this.runs.start("chat");
      const previousConversation = this.currentConversationId;
      this.currentConversationId = sessionId;
      this.working.add(sessionId);
      this.progress.emit({ kind: "turn-start", conversationId: sessionId });
      /** Set when the turn hands its ending over to a deferred settle. */
      let suspended = false;
      try {
        // A conversation may be a scoped agent: its own brief, its own reach.
        const conversation = this.conversations.get(sessionId);
        /*
         * Told the first time a call in this turn suspends on the owner, so
         * the caller can be answered while the turn itself keeps waiting.
         */
        let suspend: ((action: PendingAction) => void) | undefined;
        const waiting = new Promise<PendingAction>((resolve) => {
          suspend = resolve;
        });

        const tools = this.guardedTools({
          userId,
          conversationId: sessionId,
          onQueued: (action) => suspend?.(action),
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
          eventLimit: 4,
          projectSlug: conversation?.projectSlug ?? null,
          // A single matching word is retrieval, not relevance: one key hit,
          // a phrase, or two words in the value before a claim is injected.
          minScore: 2,
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
        const extra = [formatting, conversation?.brief, scopeNote]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join("\n\n");
        const projects = this.manifest.list();
        const { system, turnContext } = assembleSystemPrompt({
          baseSystem: this.system,
          profile: this.profile,
          projects,
          // The tables those projects own. Without them the model guessed
          // column names, and 77 sql calls on one workspace failed that way.
          schemas: describeActive(this.workspace.db, projects),
          skills: this.skillsOffered(conversation?.projectSlug ?? undefined),
          recall,
          ...(extra ? { extra } : {}),
          // What this message pulled in, kept out of the system prompt so the
          // fixed part in front of the tools is identical every turn.
          ...(mentioned ? { turnExtra: mentioned } : {}),
        });

        // Attachments ride on the turn's own message rather than the system
        // prompt, so a later turn replaying the transcript still has them.
        const userContent: ContentBlock[] = [
          { type: "text", text },
          ...attachmentBlocks(opts.attachments ?? []),
        ];
        /*
         * Sent, but not kept.
         *
         * The turn's recalled context rides at the end of the prompt, after
         * the tools and the history, so everything before it matches the last
         * turn and is served from cache. It is stripped before the turn is
         * stored: recall is derived from the transcript, and writing it back
         * would grow the transcript every turn and then feed on itself.
         */
        const sentContent: ContentBlock[] = turnContext
          ? [{ type: "text", text: turnContext }, ...userContent]
          : userContent;
        let input: string | ModelMessage[] = text;
        const useSession = !this.sessionless && !opts.noSession;
        if (useSession) {
          const prior = this.sessions.historyForPrompt(sessionId);
          input = [...prior, { role: "user", content: sentContent }];
          // Written before the model is asked anything.
          //
          // Recorded only at the end, what the owner said existed nowhere but
          // the browser for the length of the turn: reloading the page lost
          // it, and so would the process dying mid-answer. The reply is
          // appended when it arrives.
          // What the owner said, without the context this turn recalled.
          this.sessions.record(sessionId, [
            ...prior,
            { role: "user", content: userContent },
          ]);
          this.conversations.touch(
            sessionId,
            ...(opts.origin === "system" ? [] : [text]),
          );
        } else if (sentContent.length > 1) {
          input = [{ role: "user", content: sentContent }];
        }

        // The subscription path. Same tools, same jail, same approvals; the
        // difference is which account pays for the thinking.
        if (this.behaviour().engine === "sdk") {
          /*
           * The conversation so far, rendered into the prompt.
           *
           * This path was stateless: every turn arrived with only the latest
           * message, so the agent had no idea what had just been said to it.
           * KOS's own transcript stays the source of truth, which is what
           * keeps retention, /compact and rewind meaning something here.
           */
          const sdkRun = runSdkChat({
            prompt: priorForSdk(this.sessions.historyForPrompt(sessionId), text),
            // The turn's own pictures, which a prompt string cannot carry.
            ...(opts.attachments?.length
              ? { attachments: opts.attachments }
              : {}),
            system,
            tools,
            cwd: this.workspace.root,
            maxTurns: this.behaviour().maxSteps,
            onDelta: (delta) =>
              this.progress.emit({
                kind: "delta",
                conversationId: sessionId,
                of: delta.kind === "reasoning" ? "reasoning" : "text",
                text: delta.text,
              }),
            // No tool-start here: the guarded toolbox already emits one for
            // every call, and emitting a second left each bubble with two
            // starts and one end, so half of them never stopped running.
          });

          const settleSdk = (sdk: SdkChatResult): string => {
            const reply = sdk.text || "I do not have anything to add to that.";
            if (useSession) {
              /*
               * The calls, then the reply.
               *
               * These run inside the MCP bridge rather than through KOS's own
               * loop, so nothing was written down: they streamed live and
               * vanished the moment the turn ended and the transcript
               * reloaded. Stored in the same shape the other engine uses, so
               * the transcript renders them the same way.
               */
              const madeCalls = sdk.calls.flatMap((c) => [
                {
                  role: "assistant" as const,
                  content: [
                    {
                      type: "tool_use" as const,
                      id: c.id,
                      name: c.name,
                      input: c.input,
                    },
                  ],
                },
                {
                  role: "user" as const,
                  content: [
                    {
                      type: "tool_result" as const,
                      toolUseId: c.id,
                      content: c.result,
                      ...(c.isError ? { isError: true } : {}),
                    },
                  ],
                },
              ]);
              this.sessions.record(sessionId, [
                ...this.sessions.get(sessionId),
                ...madeCalls,
                { role: "assistant", content: [{ type: "text", text: reply }] },
              ]);
              this.conversations.touch(
                sessionId,
                ...(opts.origin === "system" ? [] : [text]),
              );
            }
            /*
             * One row per model the call actually used.
             *
             * This was a single row named for the engine, because the model
             * was thought to be unknowable here. The SDK reports it, along
             * with the subagent and sidechain calls the old tally missed and
             * the cached input that made a long conversation look nearly
             * free. A turn that used two models is two rows, which is what
             * the spend page is for.
             */
            for (const used of sdk.models) {
              this.spend.record({
                conversationId: sessionId,
                task: "reasoning",
                provider: "anthropic",
                model: used.model,
                inputTokens:
                  used.inputTokens +
                  used.cacheReadInputTokens +
                  used.cacheCreationInputTokens,
                outputTokens: used.outputTokens,
                /*
                 * The split and the SDK's own price, both of which were
                 * being computed and then dropped. Cached input costs a
                 * fraction of fresh input, so a total that priced all of it
                 * the same read several times high on exactly the long
                 * conversations this path is for.
                 */
                cacheReadTokens: used.cacheReadInputTokens,
                cacheCreationTokens: used.cacheCreationInputTokens,
                costUSD: used.costUSD,
              });
            }
            this.runs.finish(runId, "ok");
            return reply;
          };

          // Same bargain as the other engine: the call stays suspended inside
          // the turn, and the caller is answered rather than held for as long
          // as the owner takes to decide.
          const first = await Promise.race([
            sdkRun.then((r) => ({ kind: "done" as const, sdk: r })),
            waiting.then((action) => ({ kind: "waiting" as const, action })),
          ]);

          if (first.kind === "waiting") {
            suspended = true;
            void sdkRun
              .then((r) => (this.closed ? "" : settleSdk(r)))
              .catch((err: unknown) => {
                if (this.closed) return;
                this.runs.finish(
                  runId,
                  "error",
                  err instanceof Error ? err.message : String(err),
                );
              })
              .finally(() => this.endTurn(sessionId));
            return {
              reply: `Waiting on you: ${first.action.tool} needs approval (#${first.action.id}). I will carry on as soon as you decide.`,
              halted: false,
              sessionId,
            };
          }

          return { reply: settleSdk(first.sdk), halted: false, sessionId };
        }

        const running = runAgent(this.inference, tools, input, {
          system,
          ...(opts.task ? { task: opts.task } : {}),
          maxIterations: opts.maxIterations ?? this.behaviour().maxSteps,
          // Watched turns stream. A reader was shown one static word for the
          // whole of a turn, and with a reasoning model most of that time is
          // the model working rather than any tool running.
          shouldStop: () => this.stopping.has(sessionId),
          // So a stop lands while the turn is waiting on the model, rather
          // than at the next round trip it may never reach.
          signal: this.abortFor(sessionId).signal,
          onDelta: (delta) =>
            this.progress.emit({
              kind: "delta",
              conversationId: sessionId,
              of: delta.kind,
              text: delta.text,
            }),
        });

        /*
         * A turn that is waiting on the owner answers the owner.
         *
         * The call itself stays suspended inside the loop, which is what
         * keeps one turn, one live view and one tool bubble. But the caller
         * -- an HTTP request, a Discord message -- must not hang for as long
         * as the owner takes to decide, so the first suspension is answered
         * immediately and the rest of the turn carries on behind it.
         */
        const outcome = await Promise.race([
          running.then((r) => ({ kind: "done" as const, result: r })),
          waiting.then((action) => ({ kind: "waiting" as const, action })),
        ]);

        if (outcome.kind === "waiting") {
          suspended = true;
          // Finishes on its own, once the decision comes. The transcript, the
          // memory write and the run log all happen there, exactly as they
          // would have here.
          void running
            .then((r) =>
              this.closed
                ? ""
                : this.settleTurn(r, {
                sessionId,
                userId,
                text,
                ...(opts.origin ? { origin: opts.origin } : {}),
                    runId,
                    useSession,
                  }),
            )
            .catch((err: unknown) => {
              if (this.closed) return;
              this.runs.finish(
                runId,
                "error",
                err instanceof Error ? err.message : String(err),
              );
            })
            .finally(() => this.endTurn(sessionId));
          return {
            reply: `Waiting on you: ${outcome.action.tool} needs approval (#${outcome.action.id}). I will carry on as soon as you decide.`,
            halted: false,
            sessionId,
          };
        }

        const result = outcome.result;

        const reply = await this.settleTurn(result, {
          sessionId,
          userId,
          text,
          ...(opts.origin ? { origin: opts.origin } : {}),
          runId,
          useSession,
        });
        this.runs.finish(runId, "ok");
        return { reply, halted: false, sessionId };
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
        /*
         * A suspended turn has returned, not finished.
         *
         * Ending it here emitted turn-end the instant an approval was asked
         * for, and the live view is dropped on turn-end: every thought and
         * tool call the reader had watched build up vanished at exactly the
         * moment the approval card appeared, on both engines. The deferred
         * settle above ends the turn instead, once the decision has actually
         * been made and the rest of it has run.
         */
        if (!suspended) this.endTurn(sessionId);
      }
    }
  }

  /**
   * Where an answer goes while a press is being answered, by conversation.
   *
   * Open only for the length of that turn: an interaction is good for
   * minutes, and a card sent into a stale one is a card nobody sees.
   */
  private readonly replySurfaces = new Map<
    string,
    (msg: { text: string; card?: MessageCard; buttons?: MessageButton[] }) => Promise<void>
  >();

  /** Hold a reply surface open for one turn, and take it away after. */
  openReplySurface(
    conversationId: string,
    send: (msg: {
      text: string;
      card?: MessageCard;
      buttons?: MessageButton[];
    }) => Promise<void>,
  ): () => void {
    this.replySurfaces.set(conversationId, send);
    return () => this.replySurfaces.delete(conversationId);
  }

  /** The open surface for a conversation, if a press is being answered in it. */
  replySurfaceFor(
    conversationId?: string,
  ):
    | ((msg: {
        text: string;
        card?: MessageCard;
        buttons?: MessageButton[];
      }) => Promise<void>)
    | undefined {
    return conversationId ? this.replySurfaces.get(conversationId) : undefined;
  }

  /**
   * A scheduled job's turn, in the conversation that belongs to it.
   *
   * The thread is made the first time the job runs rather than when it is
   * written, so a schedule that never fires leaves no empty chat behind.
   */
  /** The job's thread, made on its first run so an unfired schedule leaves none. */
  private jobThread(job: CronJob): string {
    const id = cronSessionId(job.id);
    if (!this.conversations.get(id)) {
      this.conversations.create({
        id,
        userId: this.profile.ownerId,
        title: job.name,
        // A job for a project runs in that project: what it remembers lands
        // in the project's scope, and the project's claims are in reach.
        ...(job.projectSlug ? { projectSlug: job.projectSlug } : {}),
        brief: [
          `The scheduled job "${job.name}" runs here, on ${job.schedule}.`,
          "Each run is a turn in this thread, so what it did last time is above.",
          "The owner may join in and ask about a run; answer as yourself.",
        ].join(" "),
      });
    }
    return id;
  }

  /**
   * Write a fixed-actions run into the job's thread.
   *
   * An actions job makes no model call, so there was no turn to record and
   * nothing to watch or ask about afterwards: its runs were rows in the log
   * saying only whether they failed. Written in the shape a turn produces --
   * the call, then its result -- so the chat view renders it as the tool
   * calls it is, and the owner can ask about it in the same thread.
   */
  private recordActionRun(job: CronJob, results: CronActionResult[]): void {
    if (results.length === 0) return;
    const id = this.jobThread(job);
    const calls: ModelMessage[] = results.flatMap((r, i) => [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: `cron-${job.id}-${i}`,
            name: r.tool,
            input: r.args ?? {},
          },
        ],
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: `cron-${job.id}-${i}`,
            content: r.content,
            ...(r.isError ? { isError: true } : {}),
          },
        ],
      },
    ]);
    const failed = results.filter((r) => r.isError).length;
    this.sessions.record(id, [
      ...this.sessions.get(id),
      { role: "user", content: [{ type: "text", text: "The schedule fired." }] },
      ...calls,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: failed
              ? `Ran ${results.length} action${results.length === 1 ? "" : "s"}; ${failed} failed.`
              : `Ran ${results.length} action${results.length === 1 ? "" : "s"}.`,
          },
        ],
      },
    ]);
    this.conversations.touch(id);
  }

  private async runJobTurn(prompt: string, job: CronJob): Promise<string> {
    const id = this.jobThread(job);
    /*
     * Not enqueued again: fire() is already running inside the work queue,
     * and handleMessage enqueues on the conversation's own lane, so this
     * would wait on a chain that includes the task doing the waiting.
     */
    // runTurn rather than handleMessage: fire() is already inside the work
    // queue, and handleMessage enqueues on the conversation's own lane, so
    // this would wait on a chain that includes the task doing the waiting.
    const res = await this.runTurn(prompt, this.profile.ownerId, id, {
      origin: "system",
      task: job.task,
    });
    return res.reply;
  }



  /**
   * The end of a turn, wherever it happens.
   *
   * A turn that suspends on an approval returns to its caller long before it
   * is over, so this is called from the deferred settle in that case and from
   * the turn's own finally in every other.
   */
  private endTurn(sessionId: string): void {
    this.working.delete(sessionId);
    this.stopping.delete(sessionId);
    this.aborts.delete(sessionId);
    this.progress.emit({ kind: "turn-end", conversationId: sessionId });
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
  /**
   * A project's own orchestrator: the second level.
   *
   * KOS at the root routes work across projects. Each project has one of
   * these, holding the same chats tools scoped to its project, so it can run
   * agents for its own work and nothing else. An agent it starts never holds
   * chats tools at all, so there is no third level.
   */
  /** The project's orchestrator conversation, made on first use so it can be opened before it is spoken to. */
  ensureProjectConversation(slug: string): Conversation {
    const project = this.manifest.list().find((p) => p.slug === slug);
    if (!project) throw new Error(`no project with slug ${slug}`);
    const id = projectConversationId(slug);
    const existing = this.conversations.get(id);
    if (existing) return existing;
    return this.conversations.create({
      id,
      userId: this.profile.ownerId,
      title: project.name,
      channel: "dashboard",
      projectSlug: slug,
      brief: [
        `You are the orchestrator for the project "${project.name}" (slug ${slug}).`,
        "You see only this project's chats and may start agents for its work.",
        "You cannot reach other projects; KOS at the root does that.",
      ].join(" "),
    });
  }

  async handleProjectTurn(
    slug: string,
    text: string,
    opts: { channel?: string; attachments?: Attachment[] } = {},
  ): Promise<HandleResult & { conversationId: string }> {
    const id = this.ensureProjectConversation(slug).id;
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

  /** Open a chat to work out why something failed. The dashboard calls this. */
  startFix(input: { label: string; error: string; what: string; ref?: string }): Promise<{ conversationId: string; title: string; prompt: string }> {
    return this.caretaker.startFix(input);
  }

  /** Carry out the owner's decision on a queued action. Every surface comes through here. */
  approve(id: number, decidedBy?: string, options: { remember?: boolean } = {}): Promise<DecisionResult> {
    return this.decisions.approve(id, decidedBy, options);
  }

  deny(id: number, decidedBy?: string): Promise<DecisionResult> {
    return this.decisions.deny(id, decidedBy);
  }

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

    /*
     * The surface's own thread.
     *
     * It used to take the most recently updated conversation, which was
     * already a guess and became a wrong one: an agent's own thread, or a
     * scheduled job's, is the most recent thing in the workspace most of the
     * time, and neither is somewhere the owner was talking. A surface has one
     * continuous stream now, the way the dashboard does, and /switch still
     * points it elsewhere when the owner says so.
     */
    const id = surfaceSessionId(channel, userId);
    const chosen =
      this.conversations.get(id) ??
      this.conversations.create({
        id,
        userId,
        channel,
        title: channel.charAt(0).toUpperCase() + channel.slice(1),
        brief: SURFACE_BRIEF,
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
  ): Promise<
    | (HandleResult & { isCommand: true; switchedTo?: string; opens?: "tools" })
    | null
  > {
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
      ...(result.opens ? { opens: result.opens } : {}),
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
      /*
       * The surface's own thread may hand work on.
       *
       * It keeps the full toolkit, so most things happen where they were
       * asked. The chats tools are for the rest: work that already has a
       * conversation, or is big enough to want one. Granted only here,
       * because a project chat that could spawn more of itself is a loop
       * waiting to happen.
       */
      ...(conversation.id === surfaceSessionId(input.channel, input.userId)
        ? { grant: [...CHAT_TOOLS] }
        : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    return { ...res, conversationId: conversation.id, isCommand: false };
  }

  /**
   * Context for a self_prompt cron run: the same profile, manifest, and salient
   * memory a chat turn gets. Unattended jobs previously ran with no system
   * prompt at all, so the agent woke with no identity and no project context.
   */
  /** Skills the model may reach from here: on, valid, and for this project if they say. */
  private skillsOffered(projectSlug?: string): ReturnType<typeof offeredSkills> {
    return offeredSkills(
      readSkills(this.workspace).skills,
      parseSkillSettings(this.settings.get(SKILLS_KEY)).disabled,
      projectSlug,
    );
  }

  private async cronSystemPrompt(job: CronJob): Promise<string> {
    const query = job.prompt ?? job.name;
    const recall = await this.memoryRetriever.recall(this.profile.ownerId, query, {
      factLimit: 10,
      eventLimit: 4,
      projectSlug: job.projectSlug,
      minScore: 2,
    });
    const projects = this.manifest.list();
    const assembled = assembleSystemPrompt({
      baseSystem: this.system,
      profile: this.profile,
      projects,
      // The tables those projects own. Without them the model guessed
      // column names, and 77 sql calls on one workspace failed that way.
      schemas: describeActive(this.workspace.db, projects),
      skills: this.skillsOffered(job.projectSlug ?? undefined),
      recall,
      extra: [
        "## Scheduled run",
        `You are running unattended as cron job "${job.name}".`,
        "There is no one to ask, so do not ask questions.",
        "Risky actions still queue for approval; say what you queued and stop.",
      ].join("\n"),
    });
    /*
     * Joined back together. A scheduled run is one-shot -- there is no
     * previous turn for a cache to match against -- so splitting the prompt
     * would buy nothing and only change what the job sees.
     */
    return [assembled.system, assembled.turnContext]
      .filter((part) => part.trim())
      .join("\n\n");
  }







  private guardedTools(opts: {
    userId?: string;
    /** The conversation this turn belongs to, for approval routing. */
    conversationId?: string;
    /** Hard allow-list from the conversation, when it is a scoped agent. */
    allow?: string[];
    /** Restricted tools granted for this turn. */
    grant?: string[];
    /** Told the first time a call in this turn suspends on the owner. */
    onQueued?: (action: PendingAction) => void;
    /** False for unattended work, which queues an approval and moves on. */
    waitForApproval?: boolean;
  } = {}): GuardedTools {
    return new GuardedTools({
      registry: this.registry,
      secrets: this.secrets,
      audit: this.audit,
      approvals: this.approvals,
      userId: opts.userId ?? this.profile.ownerId,
      // Above the registry rather than under it. At 48 with fifty tools the
      // narrowing was on for every turn of every conversation, so the offered
      // set changed shape with the wording of each message and nothing said
      // so. Scoping is for the many-modules case it was written for.
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      permissions: this.permissions,
      projectSlug: () =>
        opts.conversationId
          ? (this.conversations.get(opts.conversationId)?.projectSlug ?? undefined)
          : undefined,
      ...(opts.allow !== undefined ? { allow: opts.allow } : {}),
      ...(opts.grant?.length ? { grant: opts.grant } : {}),
      ...(opts.waitForApproval === false ? { waitForApproval: false } : {}),
      onQueued: (action) => {
        opts.onQueued?.(action);
        this.onApprovalRequested?.(action);
      },
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
      approvalTimeoutMs: this.behaviour().approvalMinutes * 60_000,
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
   * Everything a finished turn owes: the reply it settled on, the transcript,
   * the memory write and the run log.
   *
   * Its own method because a turn can finish in two places now. One that
   * suspends on an approval answers the caller straight away and lands here
   * later, when the owner has decided, and doing that work in two copies is
   * how the two paths drift apart.
   */
  private async settleTurn(
    result: {
      messages: ModelMessage[];
      finalText: string;
      stopped?: boolean;
      exhausted: boolean;
    },
    ctx: {
      sessionId: string;
      userId: string;
      text: string;
      origin?: "owner" | "system";
      runId: number;
      useSession: boolean;
    },
  ): Promise<string> {
    const { sessionId, userId, text, origin, runId, useSession } = ctx;

    /*
     * A turn can now land here long after it started, once the owner has
     * decided about a call it was suspended on. By then the host may have
     * gone away: writing to a closed database throws somewhere nobody is
     * looking, which is how this first showed up, in CI rather than here.
     */
    if (this.closed) return "";

    // A turn that ends on a tool call has no text in it. Handed straight to
    // the reader that is silence: the agent looks like it ignored them. It
    // happens when the loop hits its iteration cap, which is exactly when the
    // reader most needs to hear that it got stuck.
    const reply =
      result.stopped && result.finalText.trim() === ""
        ? "Stopped."
        : result.finalText.trim() !== ""
          ? result.finalText
          : result.exhausted
            ? "I got stuck on that and stopped after too many steps without reaching an answer. Tell me what to try instead, or narrow it down."
            : "I do not have anything to add to that.";

    if (useSession) {
      // Persist the loop's own message list so tool calls and their results
      // survive into the next turn, not just the final text. Where the loop
      // produced no text of its own, the synthesised reply is appended, or
      // the transcript ends mid-thought and the chat reads as though nothing
      // was said.
      const spoke = result.finalText.trim() !== "";
      // Without what this turn recalled: it was sent so the model had it, and
      // keeping it would write the transcript's own summary back into the
      // transcript on every turn.
      this.sessions.record(
        sessionId,
        withoutTurnContext(
          spoke
            ? result.messages
            : [
                ...result.messages,
                { role: "assistant", content: [{ type: "text", text: reply }] },
              ],
        ),
      );
      // Only the auto-title is withheld from a resume prompt, which is
      // harness plumbing and must not rename anything.
      this.conversations.touch(
        sessionId,
        ...(origin === "system" ? [] : [text]),
      );
      /*
       * And a name, once, in the background.
       *
       * The title is the owner's first message with the end cut off, so a
       * list of them is a list of half-sentences and none of it reads at a
       * glance -- in the sidebar, in the Discord picker, or in a card saying
       * where messages are going. Not awaited: the answer is already written
       * and nobody should wait on a label for it.
       */
      if (origin !== "system") void this.afterTurn.nameIfUnnamed(sessionId, text, reply);
    }

    // Only owner turns are remembered; harness-generated ones are plumbing.
    // Awaited so a write cannot be lost when the process exits right after a
    // reply, and so failures surface in the runs log instead of vanishing.
    if (origin !== "system") {
      await this.afterTurn.remember(userId, text, reply, sessionId);
      this.maybeExtract();
    }

    this.runs.finish(runId, "ok");
    return reply;
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

  /**
   * Start looking around unprompted, if the owner has asked for it.
   *
   * Runs on its own thread and says nothing unless it decides there is
   * something worth saying, so a beat that finds nothing costs a turn and
   * makes no noise. Held to the same self-prompt budget as a scheduled job,
   * because it is the same thing: KOS deciding to spend a turn on itself.
   */
  startHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = new Heartbeat({
      interval: () => this.behaviour().heartbeatMinutes,
      // The interval is the rate limit; a second budget on top would only
      // make the cadence the owner set mean something other than it says.
      allowed: () => !this.killSwitch.halted,
      beat: heartbeatBeat({
        ownerId: this.profile.ownerId,
        enqueue: (work, lane) => this.queue.enqueue(work, lane),
        runs: this.runs,
        conversationFor: (channel, ownerId) => this.conversationFor(channel, ownerId),
        runTurn: (text, userId, sessionId, opts) => this.runTurn(text, userId, sessionId, opts),
      }),
    });
    this.heartbeat.start();
  }

  stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = undefined;
  }



  startCron(): void {
    this.cron.start();
  }

  /**
   * One scheduled job, in its own thread, with the guarded toolbox.
   *
   * A fixed-actions job runs in its thread too. Binding the toolbox to it
   * is what makes the run watchable: the guarded path already emits a
   * bubble per call, and with no conversation to emit into they went
   * nowhere. The thread is made up front for the same reason, and closed
   * whatever happened: a run where every action failed is the one most
   * worth being able to read afterwards.
   */
  private async runScheduledJob(job: CronJob): Promise<CronExecResult> {
    const jobSession = job.type === "actions" ? this.jobThread(job) : undefined;
    // The job's thread is the current conversation while it runs, as a
    // turn's is: a claim the job makes is attributed to it and lands in the
    // job's project.
    const previousConversation = this.currentConversationId;
    if (jobSession) {
      this.currentConversationId = jobSession;
      this.working.add(jobSession);
      this.progress.emit({ kind: "turn-start", conversationId: jobSession });
    }
    try {
      const result = await runCronJob(job, {
        // The job's query and condition are reads that build the variable
        // scope, so they run on the read-only handle. Writes belong in the
        // job's actions, which go through the guarded tool path.
        db: this.workspace.reader,
        tools: this.guardedTools({
          ...(jobSession ? { conversationId: jobSession } : {}),
          // Unattended: queue what needs a decision and finish, rather than
          // holding a queue slot until the owner wakes up.
          waitForApproval: false,
        }),
        inference: this.inference,
        buildSystem: (j) => this.cronSystemPrompt(j),
        // In the job's own thread, so a run can be watched while it happens,
        // asked about afterwards, and read back next week.
        runInConversation: (prompt, j) => this.runJobTurn(prompt, j),
      });
      if (jobSession && result.ran && result.type === "actions") {
        this.recordActionRun(job, result.results);
      }
      return result;
    } finally {
      this.currentConversationId = previousConversation;
      if (jobSession) this.endTurn(jobSession);
    }
  }

  /**
   * An agent-initiated message with no channel to carry it.
   *
   * It lands in the owner's primary conversation, which is the same thread the
   * CLI and a DM use, so unattended work is readable in Chats rather than
   * thrown away with "no notify channel is wired".
   */
  /**
   * Say something to the owner without being asked.
   *
   * Goes to the channel when one is wired, and to the owner's primary
   * conversation when it is not, on the principle that an unattended failure
   * should never be lost because Discord happens to be unconfigured.
   */










  /**
   * How much rope unattended work gets, as the owner has set it. Read each
   * time rather than cached: a change in settings should take effect on the
   * next turn, not the next restart.
   */
  /**
   * Let the extractor read, when the owner has it on and enough has been
   * said. Not awaited: a reply is already written, and a background read
   * is nobody's turn. Recorded as a run so what it did is in History.
   */
  private maybeExtract(): void {
    const how = this.behaviour();
    if (!how.memoryExtraction || this.extractor.busy || this.closed) return;
    if (this.extractor.pending().chars < how.extractEveryChars) return;
    // KOS reads its own memory when the owner has the job on; the fixed
    // extractor is the floor when they have not.
    const job = this.crons.list().find((c) => c.name === MEMORY_JOB);
    if (job?.enabled) {
      void this.cron.fire(job.id).catch(() => undefined);
      return;
    }
    void this.extractMemory().catch(() => undefined);
  }

  /** Run the extractor now over everything it has not read, and say what it did. */
  async extractMemory(): Promise<ExtractionReport> {
    return this.queue.enqueue(async () => {
      const runId = this.runs.start("memory.extract");
      try {
        const report = await this.extractor.run();
        this.runs.finish(runId, "ok");
        return report;
      } catch (err) {
        this.runs.finish(runId, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    }, "memory");
  }

  behaviour(): Behaviour {
    return parseBehaviour(this.settings.get(BEHAVIOUR_KEY));
  }

  /**
   * True once close() has run. Work started before a shutdown can land after
   * it, and a write to a closed database throws somewhere nobody is looking.
   */
  private closed = false;



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
  /** The providers a route may name right now. */
  providerNames(): string[] {
    const router = this.inference as { providerNames?: () => string[] };
    return router.providerNames?.() ?? [];
  }

  /**
   * Point the custom provider at an endpoint, now, without a restart. An
   * empty URL takes it away; a route still naming it will fail loudly at
   * the next turn, which is the honest outcome.
   */
  setCustomEndpoint(baseUrl: string): CustomEndpoint | undefined {
    const parsed = parseCustomEndpoint({ baseUrl }, {});
    this.settings.set(CUSTOM_ENDPOINT_KEY, parsed ?? {});
    const router = this.inference as { addProvider?: (p: Provider) => void; removeProvider?: (name: string) => void };
    if (parsed) router.addProvider?.(new OpenAICompatibleProvider(parsed.baseUrl));
    else router.removeProvider?.(CUSTOM_PROVIDER);
    return parsed;
  }

  customEndpoint(): CustomEndpoint | undefined {
    return parseCustomEndpoint(this.settings.get(CUSTOM_ENDPOINT_KEY));
  }

  async availableModels(): Promise<string[]> {
    const route = this.routes()?.["reasoning"];
    if (route?.provider === CUSTOM_PROVIDER) {
      const router = this.inference as { provider?: (name: string) => Provider | undefined };
      const custom = router.provider?.(CUSTOM_PROVIDER) as OpenAICompatibleProvider | undefined;
      return custom ? custom.listModels(this.secrets.get(CUSTOM_PROVIDER) ?? "") : [];
    }
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
    // Marked first, so the loop reads the flag rather than the abort and
    // reports a stop instead of a broken turn.
    this.aborts.get(sessionId)?.abort();
    return true;
  }

  /** One controller per running turn, replaced when a new turn starts. */
  private readonly aborts = new Map<string, AbortController>();

  private abortFor(sessionId: string): AbortController {
    const fresh = new AbortController();
    this.aborts.set(sessionId, fresh);
    return fresh;
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
        // By name, then by id: a failure knows the id it fired, and a job
        // renamed since is still the job that broke.
        const job =
          this.crons.list().find((c) => c.name === ref.id) ??
          (/^\d+$/.test(ref.id) ? this.crons.get(Number(ref.id)) : undefined);
        if (!job) {
          parts.push(`Schedule ${ref.id}: not found.`);
          continue;
        }
        // What it does, not just when. Anyone asked to repair a job had to
        // go and query the table for its actions before they could start.
        parts.push(
          [
            `Schedule "${job.name}" (id ${job.id}): ${job.schedule}, type ${job.type}, ${job.enabled ? "enabled" : "disabled"}.`,
            job.projectSlug ? `Project: ${job.projectSlug}` : "",
            job.query ? `Query: ${job.query}` : "",
            job.condition?.test ? `Runs only if: ${job.condition.test}` : "",
            job.actions && job.actions.length > 0
              ? `Actions: ${JSON.stringify(job.actions)}`
              : "",
            job.prompt ? `Prompt: ${job.prompt}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        continue;
      }
      if (ref.kind === "agent") {
        const build = this.builds.get(Number(ref.id));
        if (!build) {
          parts.push(`Agent ${ref.id}: not found, or its process has ended.`);
          continue;
        }
        // The tail rather than the whole log: enough to answer "what is it
        // doing" without spending the turn's context on a transcript.
        const tail = build.events
          .slice(-15)
          .map((e) => `  [${e.kind}] ${e.text.slice(0, 300)}`)
          .join("\n");
        parts.push(
          [
            `Agent ${build.id} in ${build.dir}: ${build.status}.`,
            `Asked to: ${build.task}`,
            build.askedFor > 0 ? `Has asked the owner ${build.askedFor} time(s).` : "",
            tail ? `Recent steps:\n${tail}` : "Nothing logged yet.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        continue;
      }
      if (ref.kind === "chat") {
        const chat = this.conversations.get(ref.id);
        parts.push(
          chat
            ? `Chat "${chat.title}" (${chat.id})${chat.brief ? `: ${chat.brief}` : ""}`
            : `Chat ${ref.id}: not found.`,
        );
        continue;
      }
      if (ref.kind === "site") {
        // Addressed as project/name, which is also where it lives.
        const base = sitesBaseUrl();
        parts.push(
          `Site ${ref.id}: folder projects/${ref.id.replace("/", "/sites/")}` +
            (base ? `, served at ${base}/${ref.id}/` : ", not currently served"),
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

  catchUpCron(): number {
    return this.cron.catchUp();
  }

  reloadCron(): void {
    this.cron.reload();
  }

  /** Run one job now, through the same path the schedule uses. */
  fireCron(id: number): Promise<CronFireResult> {
    return this.cron.fire(id);
  }

  /** Jobs the running scheduler actually holds, as opposed to rows in the table. */
  scheduledCronCount(): number {
    return this.cron.scheduledCount();
  }

  stopCron(): void {
    this.cron.stop();
  }

  /**
   * Bring up everything that is supposed to be running.
   *
   * Separate from boot so a test or a one-shot CLI command does not start the
   * owner's programs just by opening the workspace. The host calls it; the
   * REPL does not.
   */
  startDaemons(): void {
    for (const daemon of this.daemons.list()) {
      if (!daemon.enabled) continue;
      try {
        this.supervisor.start(daemon);
      } catch (err) {
        // One daemon that cannot start is not a reason for the host to fail
        // to come up, or for the other daemons to stay down.
        console.warn(
          `[daemons] ${daemon.project}/${daemon.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  close(): void {
    this.closed = true;
    this.stopCron();
    this.stopHeartbeat();
    // Not awaited: close is synchronous everywhere it is called from, and the
    // children are killed either way once this process goes.
    void this.supervisor.stopAll();
    // What modules opened, stdio MCP servers among them, must not outlive the host.
    void this.loader.unload();
    this.workspace.close();
  }
}

/** Seed a nightly workspace git snapshot if the owner has not defined one. */