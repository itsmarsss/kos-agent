import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { tokenize } from "../memory/facts.js";
import { reachesAll } from "../kernel/caretaker.js";
import { conversationKind, isFixed, type Conversation, type ConversationStore } from "../kernel/conversations.js";
import type { CongregationMember } from "../kernel/progress.js";
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
 * Congregate is dispatch to several at once, waited on. Each member runs in
 * its own lane, so they run in parallel, and every reply comes back in one
 * result so the next model step can write a single answer from all of them.
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
  "chats.archive",
  "chats.delete",
  "chats.dispatch",
  "chats.congregate",
] as const;

/** The most conversations one congregation may ask at once. */
export const MAX_CONGREGATION = 6;
/** How long one member may run before the congregation gives up on it. */
const DEFAULT_CONGREGATION_MS = 10 * 60_000;
/**
 * The most of one member's reply the result carries. Six long replies in one
 * tool result would crowd out the context the synthesis needs; the whole
 * reply stays in that member's own chat.
 */
const REPLY_CAP = 8_000;

/**
 * Which conversations a caller may see.
 *
 * A project orchestrator sees its own project and no other, and never
 * another project's orchestrator, so one project cannot reach into the next
 * through a dispatch. The root, with no scope, sees everything, and so
 * does Maintenance: a repair reaches what the fault reaches.
 */
function inScopeFor(deps: ChatToolDeps): (c: { id: string; projectSlug: string | null }) => boolean {
  return (c) => {
    const scope = deps.scope?.();
    if (reachesAll(scope)) return true;
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
   * Told as a congregation forms and again as each member settles, so the
   * chat that asked can show who it is waiting on.
   */
  onCongregation?: (dispatchedFrom: string, members: CongregationMember[]) => void;
  /** How long one member of a congregation may run, read at call time. */
  congregationTimeoutMs?: () => number;
  /**
   * Stand up a project and its orchestrator. The kernel owns the manifest and
   * the conversation graph, so it does the work; this is how KOS at the root
   * creates the second level.
   */
  standUpProject?: (input: { name: string; type: string }) => { slug: string; conversationId: string; name: string };
  /**
   * Pass a brief to another chat or project, from the calling chat. The
   * kernel resolves the target and delivers; this is the door the agent
   * uses instead of KOS's own tables.
   */
  handoff?: (input: { to: string; brief: string; ask?: string }) => Promise<{ conversationId: string; title: string; chars: number }>;
}

/**
 * The one chats tool every chat has.
 *
 * Delegation is kept to the orchestrators so a sub-agent cannot spawn more
 * of itself. Handing context on is not delegation: the owner asked for it
 * in this chat, the target gets a message and no tools, and the owner
 * approves the brief, once per target if they like. Without this door an
 * agent found the queue table with the sql tool and used that.
 */
function defineHandoffTool(deps: ChatToolDeps, ctx: ModuleContext): void {
  ctx.registerTool(
    {
      name: "chats.handoff",
      description:
        "Pass what this chat knows to another chat or project, in your own words: what matters, what was decided, what is open, with @file: " +
        "references for anything on disk. Write the brief; never copy a transcript. `to` is @chat:<id> or @project:<slug> (a project means its " +
        "orchestrator). `ask` is what that chat should do with it now, if anything; without it the brief is kept there for later. The owner " +
        "approves the brief once per target. It returns as soon as it is handed over; the answer comes back as a note here. " +
        "Never hand work back to the chat it came from: that chat hears your answer as a note. Work passes on at most three times; after that, answer where you are.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "@chat:<id>, @project:<slug>, @blob:<name>, or the id, slug or name" },
          brief: { type: "string", description: "what the other chat needs to know, in your words" },
          ask: { type: "string", description: "what it should do with it now, if anything" },
        },
        required: ["to", "brief"],
      },
    },
    async (input) => {
      if (!deps.handoff) throw new Error("handing off is not wired here");
      const ask = typeof input["ask"] === "string" && input["ask"].trim() ? input["ask"].trim() : undefined;
      const done = await deps.handoff({ to: str(input, "to"), brief: str(input, "brief"), ...(ask ? { ask } : {}) });
      return JSON.stringify({ ...done, note: "Handed over. Say so and end your turn; the answer comes back here as a note." });
    },
    // A brief handed to another of the owner's own chats stays inside the
    // workspace; what that chat then does is gated by its own tiers. Asking
    // here put an approval between "ask the books project to check" and the
    // check.
    { floor: "safe" },
  );
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

  /**
   * A chat the caller may put away: one in its reach, and an ordinary one.
   * A project's own thread, a blob's thread and the owner's chats with KOS
   * are fixed, and the dashboard refuses them the same way.
   */
  const reachable = (id: string, verb: string): Conversation => {
    const target = conversations.get(id);
    if (!target) throw new Error(`no conversation ${id}`);
    if (isFixed(target, ownerId)) {
      const kind = conversationKind(target, ownerId);
      const what = kind === "project" ? "a project's own thread" : kind === "agent" ? "a blob's thread" : kind === "schedule" ? "a schedule's thread" : "a chat of the owner's with KOS";
      throw new Error(`${target.title} is ${what} and cannot be ${verb}`);
    }
    if (!inScopeFor(deps)(target)) throw new Error(`${target.title} is not in your reach: it belongs to another project`);
    return target;
  };

  ctx.registerTool(
    {
      name: "chats.archive",
      description:
        "Archive a conversation, or bring one back with archived: false. An archived chat leaves the list and keeps its history. Only a chat in your reach: a project's orchestrator reaches its own project's chats, KOS at the root and Maintenance reach any ordinary chat. A project's own thread, a blob's thread and the owner's chats with KOS are fixed.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "the conversation id, as chats.list gives it" },
          archived: { type: "boolean", description: "false to bring an archived chat back; true (the default) to put it away" },
        },
        required: ["id"],
      },
    },
    async (input) => {
      const target = reachable(str(input, "id"), "archived");
      const archived = input.archived !== false;
      conversations.setArchived(target.id, archived);
      return JSON.stringify({ id: target.id, title: target.title, archived });
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "chats.delete",
      description:
        "Delete a conversation for good, history and all. Archive is the reversible way to set one aside; delete only when the owner wants it gone. The same reach as chats.archive, and never the chat you are speaking from. This asks the owner first.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "the conversation id, as chats.list gives it" } },
        required: ["id"],
      },
    },
    async (input) => {
      const id = str(input, "id");
      if (id === deps.currentConversationId?.()) throw new Error("that is the chat you are speaking from; it cannot delete itself");
      const target = reachable(id, "deleted");
      const removed = conversations.remove(target.id);
      return JSON.stringify({ id: target.id, title: target.title, removed });
    },
    { floor: "risky", why: "deletes the chat for good" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "chats.project",
      description:
        "Stand up a project and hand its orchestrator the goal. Use this for a distinct, ongoing piece of the owner's life or work that deserves its own space: a tracker, an app, a plan, a trip, anything the owner will come back to. A project may be mostly conversation and have no tables or pages at all; its orchestrator decides what the work needs. It creates the project and a project orchestrator conversation, then delegates the goal to that orchestrator, which runs its own agents. For a quick one-off, use chats.create instead; for work a project already covers, use chats.dispatch to its orchestrator. Only KOS at the root can start a project.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "the project's name, as it reads in a list: \"Pantry\", \"Reading Log\"" },
          type: { type: "string", description: "a short kind: tracker, notes, budget, app" },
          goal: { type: "string", description: "what the project is for and the first thing to do, written as an instruction to its orchestrator" },
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

/** What one member of a congregation is asked, and where. */
interface CongregationTarget {
  id?: string;
  title?: string;
  brief?: string;
  message: string;
}

/** Shape-check every target before anything is created or dispatched. */
function parseTargets(raw: unknown): CongregationTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("targets must name at least one conversation to ask");
  }
  if (raw.length > MAX_CONGREGATION) {
    throw new Error(`a congregation asks at most ${MAX_CONGREGATION} conversations at once; got ${raw.length}`);
  }
  return raw.map((entry, i) => {
    const t = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const message = typeof t.message === "string" ? t.message.trim() : "";
    if (!message) throw new Error(`targets[${i}] has no message`);
    const id = typeof t.id === "string" && t.id !== "" ? t.id : undefined;
    const title = typeof t.title === "string" && t.title.trim() !== "" ? t.title.trim() : undefined;
    if (!id && !title) throw new Error(`targets[${i}] needs an id to reach or a title to start`);
    const brief = typeof t.brief === "string" && t.brief.trim() !== "" ? t.brief.trim() : undefined;
    return { message, ...(id ? { id } : {}), ...(title ? { title } : {}), ...(brief ? { brief } : {}) };
  });
}

/** Reject after `ms`, and let the timer go the moment either side settles. */
function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

function capReply(reply: string): string {
  if (reply.length <= REPLY_CAP) return reply;
  return `${reply.slice(0, REPLY_CAP)}\n[cut at ${REPLY_CAP} characters; the full reply is in that conversation]`;
}

function defineCongregateTool(deps: ChatToolDeps, ctx: ModuleContext): void {
  const { conversations, ownerId } = deps;
  const hidden = new Set(deps.hide ?? []);
  const inScope = inScopeFor(deps);

  ctx.registerTool(
    {
      name: "chats.congregate",
      description:
        "Ask several conversations at once and wait for all of them. Use this when a question needs more than one angle, or when several pieces of work can run at the same time: each target is an existing conversation by id, or a new one to start with a title and optional brief, and each gets its own message. It runs them in parallel, waits for every one, and returns every reply together. Then write ONE combined answer in your own words: reconcile what they agree and disagree on, drop repetition, and summarize. Do not paste the replies. A member that fails or runs too long comes back with ok:false and the reason; say so and answer from the rest.",
      inputSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CONGREGATION,
            description: "who to ask, one entry per conversation; at most six",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "an existing conversation to ask" },
                title: {
                  type: "string",
                  description:
                    "or a new conversation to start, named as it would appear in a list: \"Cost Angle\", \"Security Review\"",
                },
                brief: { type: "string", description: "standing instructions for a new conversation" },
                message: {
                  type: "string",
                  description:
                    "the task or question for this member, written as the owner would say it TO that agent, never as a question back to the owner",
                },
              },
              required: ["message"],
            },
          },
          question: {
            type: "string",
            description: "what the owner asked, echoed back beside the replies so the combined answer stays on it",
          },
        },
        required: ["targets"],
      },
    },
    async (input) => {
      // Everything is checked before anything is made, so a bad id in the
      // list does not leave a half-created congregation behind.
      const targets = parseTargets(input.targets);
      const question = typeof input.question === "string" && input.question.trim() !== "" ? input.question.trim() : undefined;
      for (const t of targets) {
        if (!t.id) continue;
        const existing = conversations.get(t.id);
        // Out of scope reads as absent, the same as dispatch: a project
        // orchestrator cannot learn that another project's conversation exists.
        if (hidden.has(t.id) || !existing || existing.userId !== ownerId || !inScope(existing)) {
          throw new Error(`no such conversation: ${t.id}`);
        }
      }
      // Read now, not when a member settles: by then another lane may be the
      // current one.
      const from = deps.currentConversationId?.();
      const timeoutMs = deps.congregationTimeoutMs?.() ?? DEFAULT_CONGREGATION_MS;

      const members: Array<CongregationMember & { message: string }> = targets.map((t) => {
        const conversation = t.id
          ? conversations.get(t.id)!
          : conversations.create({
              projectSlug: deps.scope?.() ?? null,
              userId: ownerId,
              title: t.title!,
              ...(t.brief ? { brief: t.brief } : {}),
            });
        return { id: conversation.id, title: conversation.title, status: "working", message: t.message };
      });

      const roster = (): void => {
        if (!from) return;
        deps.onCongregation?.(
          from,
          members.map(({ id, title, status }) => ({ id, title, status })),
        );
      };
      roster();

      // Each member runs in its own lane, so this is the fan-out; one that
      // fails or runs too long is reported as such instead of taking the
      // others down with it.
      const results = await Promise.all(
        members.map(async (member) => {
          try {
            const res = await withTimeout(
              deps.dispatch(member.id, member.message),
              timeoutMs,
              `gave up waiting after ${Math.round(timeoutMs / 60_000)} minutes; it may still be working in its own conversation`,
            );
            member.status = "done";
            return { id: member.id, title: member.title, ok: true, reply: capReply(res.reply) };
          } catch (err) {
            member.status = "failed";
            const reason = err instanceof Error ? err.message : String(err);
            return { id: member.id, title: member.title, ok: false, reply: `It failed: ${reason}` };
          } finally {
            roster();
          }
        }),
      );

      return JSON.stringify({ ...(question ? { question } : {}), members: results });
    },
    // Every member's turn is governed by its own conversation's risk tiers.
    { floor: "safe" },
    { restricted: true },
  );
}

export function createChatsModule(deps: ChatToolDeps): KosModule {
  return {
    manifest: {
      name: "chats",
      version: "1.0.0",
      provides: [...CHAT_TOOLS, "chats.handoff"].map((name) => ({
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
      defineCongregateTool(deps, ctx);
      defineHandoffTool(deps, ctx);
    },
  };
}
