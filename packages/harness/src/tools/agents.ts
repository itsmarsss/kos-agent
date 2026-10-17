import cron from "node-cron";

import { agentConversationId, ROLE_NAME, type Role, type RoleRecord, type RoleStore } from "../agents/roles.js";
import type { Conversation } from "../kernel/conversations.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";

/**
 * The `agents` tool module: standing agents KOS makes from a sentence.
 *
 * A one-off goes to a chat; a responsibility ("keep an eye on", "every
 * Saturday", "handle my travel") needs somewhere to live between asks. These
 * tools make that place: a role file the owner can read and edit, a standing
 * thread for it, and a schedule when it has one. Nothing here is written for
 * any particular job; the shopper, the researcher and the planner are all
 * the same four calls with different briefs.
 *
 * Kept to the orchestrators, as the chats tools are, so an agent cannot
 * spawn more of itself.
 */

export const AGENT_TOOLS = ["agents.list", "agents.create", "agents.dispatch", "agents.remove"] as const;

export interface AgentToolDeps {
  roles: RoleStore;
  ownerId: string;
  /** The project the calling conversation belongs to, read at call time. */
  scope?: () => string | undefined;
  /** Which conversation is dispatching, for routing the answer back to it. */
  currentConversationId?: () => string | undefined;
  /** A role's standing thread, made if it is not there. */
  ensureAgent: (name: string) => Conversation;
  /** An instance of a role inside a project: an ordinary chat there, under the role's brief. */
  spawnAgent: (name: string, projectSlug: string) => Conversation;
  /** The role's schedule as a job, in step with the file; undefined removes it. */
  bindSchedule: (name: string, role: Role | undefined) => { id: number; schedule: string } | undefined;
  /** Run a turn inside a conversation and return its reply. The kernel owns the queue. */
  dispatch: (conversationId: string, text: string) => Promise<{ reply: string; conversationId: string }>;
  /** Told when a dispatched conversation answers, so the chat that delegated can say so. */
  onDispatchDone?: (conversationId: string, title: string, reply: string, dispatchedFrom?: string) => void;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`missing arg: ${key}`);
  return v.trim();
}

function optional(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return items.length ? items : undefined;
}

/** What a role looks like in a list: enough to choose one, not its whole brief. */
function summary(r: RoleRecord): Record<string, unknown> {
  return {
    name: r.name,
    description: r.description,
    tools: r.tools ?? "all",
    memory: r.memory,
    ...(r.task ? { task: r.task } : {}),
    ...(r.schedule ? { schedule: r.schedule } : {}),
    conversationId: agentConversationId(r.name),
    path: r.path,
  };
}

function defineAgentTools(deps: AgentToolDeps, ctx: ModuleContext): void {
  const from = (): string | undefined => deps.currentConversationId?.();

  ctx.registerTool(
    {
      name: "agents.list",
      description:
        "The standing agents that exist: name, what each is for, what it may reach, and when it runs. Read this before making one, since the responsibility may already have a home.",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const { roles, invalid } = deps.roles.list();
      return JSON.stringify({ agents: roles.map(summary), ...(invalid.length ? { invalid } : {}) });
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "agents.create",
      description:
        "Make a standing agent for a responsibility the owner wants kept, as a file they can read and edit (agents/<name>.md) with a thread of its own. " +
        "Give it a brief in the second person saying what it is for, how to do the work, and when to tell the owner. " +
        "A schedule makes it run unattended with the prompt on each run; without one it works only when dispatched or spoken to. " +
        "Leave tools unset unless the owner asked to limit them. Say what you made afterwards, in a line.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "short and plain, like research, shopper or saturdays" },
          description: { type: "string", description: "one line: what it is for, as a list would show it" },
          brief: { type: "string", description: "its standing instructions" },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "ONLY when the owner asked to limit it: tool families it may reach, like browser, memory, files. Omit for the full toolkit.",
          },
          memory: {
            type: "string",
            enum: ["own", "shared"],
            description: "own (default): it remembers in a scope of its own, read in its turns beside the global claims. shared: the ordinary rule.",
          },
          task: { type: "string", enum: ["reasoning", "cheap"], description: "which model class answers it; the reasoning route unless the work is routine" },
          schedule: { type: "string", description: "a cron expression, when it should run on its own" },
          prompt: { type: "string", description: "what it is told on each scheduled run; required with a schedule" },
          replace: { type: "boolean", description: "rewrite an agent that already exists; otherwise an existing name is refused" },
        },
        required: ["name", "description", "brief"],
      },
    },
    (input) => {
      const name = str(input, "name").toLowerCase();
      if (!ROLE_NAME.test(name)) throw new Error(`name must be short and plain, like research or shopper (${ROLE_NAME})`);
      if (deps.roles.exists(name) && input.replace !== true) {
        throw new Error(`there is already an agent called ${name}. Read it with agents.list; pass replace: true to rewrite it.`);
      }
      const schedule = optional(input, "schedule");
      if (schedule && !cron.validate(schedule)) throw new Error(`not a cron schedule: ${schedule}`);
      const prompt = optional(input, "prompt");
      if (schedule && !prompt) throw new Error("a schedule needs a prompt: what to do on each run");
      const tools = stringList(input.tools);
      const role: Role = {
        name,
        description: str(input, "description"),
        brief: str(input, "brief"),
        memory: input.memory === "shared" ? "shared" : "own",
        ...(tools ? { tools } : {}),
        ...(input.task === "cheap" || input.task === "reasoning" ? { task: input.task } : {}),
        ...(schedule ? { schedule } : {}),
        ...(prompt ? { prompt } : {}),
      };
      const record = deps.roles.write(role);
      const thread = deps.ensureAgent(name);
      const job = deps.bindSchedule(name, record);
      return JSON.stringify({
        name,
        path: record.path,
        conversationId: thread.id,
        ...(job ? { job } : {}),
        note: job
          ? `Made. It runs on ${job.schedule} in its own thread; dispatch work to it with agents.dispatch. The owner can edit ${record.path}.`
          : `Made. Dispatch work to it with agents.dispatch. The owner can edit ${record.path}.`,
      });
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "agents.dispatch",
      description:
        "Give a task to a standing agent. At the root it goes to the agent's own thread; from inside a project, or with a project named, the agent gets a chat in that project so what it makes lands there. " +
        "It returns as soon as the work is handed over: say what you delegated and end your turn. The owner is told when it answers.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "the agent's name, from agents.list" },
          task: { type: "string", description: "the instruction, written the way the owner would say it TO the agent" },
          project: { type: "string", description: "a project slug: run the agent inside that project rather than in its own thread" },
        },
        required: ["agent", "task"],
      },
    },
    async (input) => {
      const name = str(input, "agent").toLowerCase();
      if (!deps.roles.get(name)) throw new Error(`no agent called ${name}; agents.list says which exist`);
      const task = str(input, "task");
      const here = deps.scope?.();
      const project = optional(input, "project") ?? here;
      // A project orchestrator sends agents into its own project and no other.
      if (here !== undefined && project !== here) throw new Error(`from this project an agent can only be sent into ${here}`);
      const target = project ? deps.spawnAgent(name, project) : deps.ensureAgent(name);
      // Handed over, not waited on, as chats.dispatch does: the agent's turn
      // may be minutes of work, and the answer comes back as its own note.
      void deps
        .dispatch(target.id, task)
        .then((res) => deps.onDispatchDone?.(target.id, target.title, res.reply, from()))
        .catch((err: unknown) =>
          deps.onDispatchDone?.(target.id, target.title, `It failed: ${err instanceof Error ? err.message : String(err)}`, from()),
        );
      return JSON.stringify({
        conversationId: target.id,
        title: target.title,
        ...(project ? { project } : {}),
        started: true,
        note: "Handed over. Do not wait for it: say it is running and end your turn. The owner is told when it answers.",
      });
    },
    // The dispatched turn is governed by its own conversation's risk tiers.
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "agents.remove",
      description: "Remove a standing agent: its file and its schedule. Its thread stays, as an ordinary chat the owner can keep or delete.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    (input) => {
      const name = str(input, "name").toLowerCase();
      if (!deps.roles.remove(name)) throw new Error(`no agent called ${name}`);
      deps.bindSchedule(name, undefined);
      return JSON.stringify({ removed: name, note: "Its file and schedule are gone; its thread stays as an ordinary chat." });
    },
    // A file of the owner's goes with it, so it asks.
    { floor: "risky" },
    { restricted: true },
  );
}

export function createAgentsModule(deps: AgentToolDeps): KosModule {
  return {
    manifest: {
      name: "agents",
      version: "1.0.0",
      provides: AGENT_TOOLS.map((name) => ({ kind: "tool" as const, name, version: "1.0.0" })),
      riskTier: "safe",
    },
    activate(ctx) {
      defineAgentTools(deps, ctx);
    },
  };
}
