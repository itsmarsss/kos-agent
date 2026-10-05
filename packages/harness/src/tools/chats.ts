import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { tokenize } from "../memory/facts.js";
import type { ConversationStore } from "../kernel/conversations.js";
import type { SessionStore } from "../kernel/session.js";

/**
 * Tools over the conversation graph, for the orchestrator only.
 *
 * Every one is marked restricted, so an ordinary conversation cannot reach
 * them even by naming one: an agent that can read your other threads and start
 * new ones is a different privilege level from an agent that can read a file.
 *
 * The set reads, creates, and dispatches. Dispatch is what makes this an
 * orchestrator rather than a filing clerk: it hands a task to the conversation
 * that owns it and reports back what actually happened, instead of announcing
 * that a thread now exists.
 *
 * A dispatched conversation never holds these tools itself, so a sub-agent
 * cannot dispatch further and the delegation is one level deep by construction.
 */

export const CHAT_TOOLS = [
  "chats.list",
  "chats.search",
  "chats.read",
  "chats.project",
  "chats.create",
  "chats.dispatch",
] as const;

/**
 * Which conversations a caller may see.
 *
 * A project orchestrator sees its own project and no other, and never
 * another project's orchestrator, so one project cannot reach into the next
 * through a dispatch. The root, with no scope, sees everything.
 */
function inScopeFor(deps: ChatToolDeps): (c: { id: string; projectSlug: string | null }) => boolean {
  return (c) => {
    const scope = deps.scope?.();
    if (scope === undefined) return true;
    return c.projectSlug === scope && !c.id.startsWith("project:");
  };
}

export interface ChatToolDeps {
  conversations: ConversationStore;
  sessions: SessionStore;
  ownerId: string;
  /** Conversations the orchestrator should never surface, e.g. itself. */
  hide?: string[];
  /**
   * The project the calling conversation belongs to, read at call time.
   *
   * Set, the tools see only that project's conversations and stamp new ones
   * with it: a project orchestrator manages its own project and nothing
   * else. Unset is the root, which sees everything.
   */
  scope?: () => string | undefined;
  /**
   * Run a turn inside another conversation and return its reply. Supplied by
   * the kernel, which owns the queue discipline this has to respect.
   */
  dispatch: (
    conversationId: string,
    text: string,
  ) => Promise<{ reply: string; conversationId: string }>;
  /**
   * Told when a dispatched conversation answers, so the chat that delegated
   * can say so without having waited for it.
   */
  onDispatchDone?: (
    conversationId: string,
    title: string,
    reply: string,
    dispatchedFrom?: string,
  ) => void;
  /** Which conversation is dispatching, for routing the answer back to it. */
  currentConversationId?: () => string | undefined;
  /**
   * Stand up a project and its orchestrator. The kernel owns the manifest and
   * the conversation graph, so it does the work; this is how KOS at the root
   * creates the second level.
   */
  standUpProject?: (input: { name: string; type: string }) => { slug: string; conversationId: string; name: string };
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

/** Flatten a transcript to spoken turns; tool round-trips are noise here. */
function spokenTurns(
  sessions: SessionStore,
  id: string,
): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  for (const message of sessions.get(id)) {
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
    if (text) out.push({ role: message.role === "user" ? "owner" : "kos", text });
  }
  return out;
}

const SNIPPET = 160;
const MAX_HITS = 8;

function defineChatTools(deps: ChatToolDeps, ctx: ModuleContext): void {
  const { conversations, sessions, ownerId } = deps;
  const hidden = new Set(deps.hide ?? []);
  const inScope = inScopeFor(deps);
  const visible = (): ReturnType<ConversationStore["list"]> =>
    conversations.list(ownerId).filter((c) => !hidden.has(c.id) && inScope(c));

  ctx.registerTool(
    {
      name: "chats.list",
      description:
        "List the owner's conversations, newest first, with id, title and when it was last active. Start here to see what already exists.",
      inputSchema: { type: "object", properties: {} },
    },
    () =>
      JSON.stringify(
        visible().map((c) => ({
          id: c.id,
          title: c.title,
          // ISO, not epoch: handed a bare number the model reads it back to
          // the owner as a number.
          lastActive: new Date(c.updatedAt).toISOString(),
          brief: c.brief,
        })),
      ),
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "chats.search",
      description:
        "Find conversations whose title or transcript mentions the query. Use before starting anything new, to see whether the work already lives somewhere.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    (input) => {
      const terms = tokenize(str(input, "query"));
      if (terms.length === 0) return JSON.stringify([]);

      const hits: Array<{ id: string; title: string; score: number; snippet: string }> = [];
      for (const c of visible()) {
        const turns = spokenTurns(sessions, c.id);
        const haystack = `${c.title}\n${turns.map((t) => t.text).join("\n")}`.toLowerCase();
        let score = 0;
        let snippet = "";
        for (const term of terms) {
          const at = haystack.indexOf(term);
          if (at === -1) continue;
          score += c.title.toLowerCase().includes(term) ? 2 : 1;
          if (!snippet) {
            snippet = haystack.slice(Math.max(0, at - 40), at + SNIPPET).trim();
          }
        }
        if (score > 0) hits.push({ id: c.id, title: c.title, score, snippet });
      }
      hits.sort((a, b) => b.score - a.score);
      return JSON.stringify(hits.slice(0, MAX_HITS));
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "chats.read",
      description:
        "Read the recent turns of one conversation, to pull out what a new one would need to know.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          limit: { type: "number", description: "most recent turns, default 20" },
        },
        required: ["id"],
      },
    },
    (input) => {
      const id = str(input, "id");
      const target = conversations.get(id);
      if (hidden.has(id) || !target || !inScope(target)) {
        throw new Error(`no such conversation: ${id}`);
      }
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.min(100, Math.floor(input.limit))
          : 20;
      return JSON.stringify(spokenTurns(sessions, id).slice(-limit));
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "chats.create",
      description:
        "Start a conversation for a piece of work and put it to work. The task is delivered as the owner's own message and that conversation runs it immediately, so its answer comes back to you. Only call this when you can state a concrete task; if you cannot, ask the owner what is missing instead. It gets the full toolkit by default.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "What the conversation is about, the way it would appear in a list: \"Workout Log\", \"Snake Game\". Not the task. \"Create Workout Log Schema and Dashboard\" reads as a to-do the first time and as nothing at all once it is done.",
          },
          brief: {
            type: "string",
            description: "standing instructions for that conversation",
          },
          toolAllow: {
            type: "array",
            items: { type: "string" },
            description:
              "ONLY set this if the owner explicitly asked to limit the conversation's tools. Omit it otherwise: the default is the full toolkit, and a restriction you guessed at becomes a capability the conversation silently lacks.",
          },
          task: {
            type: "string",
            description:
              "The instruction to carry out, written the way the owner would say it TO the agent. It is delivered as the owner's own message, so write 'Create a directory called test-dir', never 'Please tell me which directories you want'. Addressing the owner here produces an agent that asks a question instead of doing the work. Include any context carried over from other conversations.",
          },
        },
        required: ["title", "brief", "task"],
      },
    },
    async (input) => {
      const toolAllow = Array.isArray(input.toolAllow)
        ? (input.toolAllow as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
      const created = conversations.create({
        projectSlug: deps.scope?.() ?? null,
        userId: ownerId,
        title: str(input, "title"),
        brief: str(input, "brief"),
        ...(toolAllow?.length ? { toolAllow } : {}),
      });

      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (!task) {
        // Required by the schema; this is the belt to that braces. A
        // conversation with nothing asked of it is the empty-thread bug.
        return JSON.stringify({
          id: created.id,
          title: created.title,
          started: false,
          note: "No task given, so nothing ran. Dispatch one, or ask the owner what the first step should be.",
        });
      }

      // Asked as the owner, then actually run. Seeding a note from KOS instead
      // left a conversation holding a message nobody had asked anything of, so
      // it sat there looking created and doing nothing.
      const res = await deps.dispatch(created.id, task);
      return JSON.stringify({
        id: created.id,
        title: created.title,
        started: true,
        reply: res.reply,
      });
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "chats.project",
      description:
        "Stand up a project and hand its orchestrator the goal. Use this for a distinct, ongoing piece of work that deserves its own space, tables and pages: a tracker, an app, anything with more than one part. It creates the project and a project orchestrator conversation, then delegates the goal to that orchestrator, which builds it and runs its own agents. For a quick one-off, use chats.create instead; for work a project already covers, use chats.dispatch to its orchestrator. Only KOS at the root can start a project.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "the project's name, as it reads in a list: \"Pantry\", \"Reading Log\"" },
          type: { type: "string", description: "a short kind: tracker, notes, budget, app" },
          goal: { type: "string", description: "what the project is for and what to build first, written as an instruction to its orchestrator" },
        },
        required: ["name", "type", "goal"],
      },
    },
    async (input) => {
      if (deps.scope?.() !== undefined) {
        throw new Error("only KOS at the root can start a project; a project orchestrator runs its own project with chats.create");
      }
      if (!deps.standUpProject) throw new Error("projects are not available here");
      const { slug, conversationId, name } = deps.standUpProject({ name: str(input, "name"), type: str(input, "type") });
      const res = await deps.dispatch(conversationId, str(input, "goal"));
      return JSON.stringify({ project: slug, title: name, conversationId, started: true, reply: res.reply });
    },
    { floor: "safe" },
    { restricted: true },
  );
}

function defineDispatchTool(deps: ChatToolDeps, ctx: ModuleContext): void {
  const { conversations, ownerId } = deps;
  const hidden = new Set(deps.hide ?? []);
  const inScope = inScopeFor(deps);

  ctx.registerTool(
    {
      name: "chats.dispatch",
      description:
        "Give a task to one of the owner's conversations. That conversation runs with its own brief and tools, so use this to actually get work done rather than only creating somewhere for it to happen. It returns as soon as the work is handed over, not when it is done: say what you have delegated and end your turn. The owner is told separately when that conversation answers.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "conversation id" },
          message: {
            type: "string",
            description: "what you want that conversation to do",
          },
        },
        required: ["id", "message"],
      },
    },
    async (input) => {
      const id = str(input, "id");
      const from = (): string | undefined => deps.currentConversationId?.();
      if (hidden.has(id)) throw new Error("cannot dispatch to this conversation");
      const target = conversations.get(id);
      // Out of scope reads as absent, on purpose: a project orchestrator
      // cannot learn that another project's conversation exists.
      if (!target || target.userId !== ownerId || !inScope(target)) {
        throw new Error(`no such conversation: ${id}`);
      }
      /*
       * Handed over, not waited on.
       *
       * The other conversation runs a full turn, minutes of it if there is
       * work in it, and awaiting that held this turn open for all of them:
       * KOS looked hung while something it had already delegated got on with
       * it. The answer comes back as its own note when it lands.
       */
      void deps
        .dispatch(id, str(input, "message"))
        .then((res) =>
          deps.onDispatchDone?.(id, target.title, res.reply, from()),
        )
        .catch((err: unknown) =>
          deps.onDispatchDone?.(
            id,
            target.title,
            `It failed: ${err instanceof Error ? err.message : String(err)}`,
            from(),
          ),
        );

      return JSON.stringify({
        conversationId: id,
        title: target.title,
        started: true,
        note: "Handed over. Do not wait for it: say it is running and end your turn. The owner is told when it answers.",
      });
    },
    // The dispatched turn is governed by its own conversation's risk tiers, so
    // anything dangerous it tries still queues for approval there.
    { floor: "safe" },
    { restricted: true },
  );
}

export function createChatsModule(deps: ChatToolDeps): KosModule {
  return {
    manifest: {
      name: "chats",
      version: "1.0.0",
      provides: CHAT_TOOLS.map((name) => ({
        kind: "tool" as const,
        name,
        version: "1.0.0",
      })),
      riskTier: "safe",
    },
    activate(ctx) {
      requireServices(ctx);
      defineChatTools(deps, ctx);
      defineDispatchTool(deps, ctx);
    },
  };
}
