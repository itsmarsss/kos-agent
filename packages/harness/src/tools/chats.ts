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
 * The set is deliberately read-and-create. Nothing here speaks inside an
 * existing conversation, so the orchestrator can gather context and hand off,
 * but never acts as you in a thread you are not looking at.
 */

export const CHAT_TOOLS = [
  "chats.list",
  "chats.search",
  "chats.read",
  "chats.create",
] as const;

export interface ChatToolDeps {
  conversations: ConversationStore;
  sessions: SessionStore;
  ownerId: string;
  /** Conversations the orchestrator should never surface, e.g. itself. */
  hide?: string[];
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
        "Start a conversation for a piece of work. Give it a title, a brief saying what it is for and how to behave, an optional tool allow-list to keep it narrow, and an opening message carrying over anything it needs from elsewhere. Returns the id so the owner can be pointed at it.",
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
              "tool name prefixes it may use, e.g. files, sql, search. Omit for the usual toolset.",
          },
          opening: {
            type: "string",
            description: "first message in the new conversation, e.g. carried-over context",
          },
        },
        required: ["title", "brief"],
      },
    },
    (input) => {
      const toolAllow = Array.isArray(input.toolAllow)
        ? (input.toolAllow as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
      const created = conversations.create({
        userId: ownerId,
        title: str(input, "title"),
        brief: str(input, "brief"),
        ...(toolAllow?.length ? { toolAllow } : {}),
      });
      // The opening message is seeded as KOS speaking, so the owner reads it as
      // a handoff note rather than words put in their own mouth.
      const opening = typeof input.opening === "string" ? input.opening.trim() : "";
      if (opening) {
        sessions.record(created.id, [
          { role: "assistant", content: [{ type: "text", text: opening }] },
        ]);
      }
      return JSON.stringify({
        id: created.id,
        title: created.title,
        brief: created.brief,
        toolAllow: created.toolAllow,
      });
    },
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
    },
  };
}
