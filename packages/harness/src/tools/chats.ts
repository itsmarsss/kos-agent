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
  "chats.create",
  "chats.dispatch",
] as const;

export interface ChatToolDeps {
  conversations: ConversationStore;
  sessions: SessionStore;
  ownerId: string;
  /** Conversations the orchestrator should never surface, e.g. itself. */
  hide?: string[];
  /**
   * Run a turn inside another conversation and return its reply. Supplied by
   * the kernel, which owns the queue discipline this has to respect.
   */
  dispatch: (
    conversationId: string,
    text: string,
  ) => Promise<{ reply: string; conversationId: string }>;
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
  const visible = (): ReturnType<ConversationStore["list"]> =>
    conversations.list(ownerId).filter((c) => !hidden.has(c.id));

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
          updatedAt: c.updatedAt,
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
      if (hidden.has(id) || !conversations.get(id)) {
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
        "Start a conversation for a piece of work and put it to work. Give it a title, a brief saying what it is for and how to behave, and the task to do first, including anything it needs to know from elsewhere. The task is asked as the owner, that conversation runs it immediately, and its answer comes back to you. It gets the full toolkit by default.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
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
              "what that conversation should do first, phrased as the owner asking for it. Include the carried-over context it needs. Omit only when the owner asked to set something up without starting it.",
          },
        },
        required: ["title", "brief"],
      },
    },
    async (input) => {
      const toolAllow = Array.isArray(input.toolAllow)
        ? (input.toolAllow as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
      const created = conversations.create({
        userId: ownerId,
        title: str(input, "title"),
        brief: str(input, "brief"),
        ...(toolAllow?.length ? { toolAllow } : {}),
      });

      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (!task) {
        return JSON.stringify({
          id: created.id,
          title: created.title,
          started: false,
          note: "Created but not started. Dispatch a task to it, or tell the owner it is waiting.",
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
}

function defineDispatchTool(deps: ChatToolDeps, ctx: ModuleContext): void {
  const { conversations, ownerId } = deps;
  const hidden = new Set(deps.hide ?? []);

  ctx.registerTool(
    {
      name: "chats.dispatch",
      description:
        "Give a task to one of the owner's conversations and get its answer back. That conversation runs with its own brief and tools, so use this to actually get work done rather than only creating somewhere for it to happen. Returns its reply, which you should summarise for the owner.",
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
      if (hidden.has(id)) throw new Error("cannot dispatch to this conversation");
      const target = conversations.get(id);
      if (!target || target.userId !== ownerId) {
        throw new Error(`no such conversation: ${id}`);
      }
      const res = await deps.dispatch(id, str(input, "message"));
      return JSON.stringify({
        conversationId: res.conversationId,
        title: target.title,
        reply: res.reply,
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
