import cron from "node-cron";

import { agentConversationId, parseFaceLook, ROLE_NAME, type Role, type RoleRecord, type RoleStore } from "../agents/roles.js";
import type { Conversation } from "../kernel/conversations.js";
import { whenWords } from "../kernel/when.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";

/**
 * The `blobs` tool module: the standing helpers KOS makes from a sentence.
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

export const BLOB_TOOLS = ["blobs.list", "blobs.create", "blobs.dispatch", "blobs.pause", "blobs.resume", "blobs.remove"] as const;

/** A blob's schedule as the scheduler holds it: whether it will fire, and when it did and will. */
export interface BlobJob {
  id: number;
  schedule: string;
  enabled: boolean;
  lastRunAt: number | null;
  /** Null while paused: nothing is coming. */
  nextRunAt: number | null;
}

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
  /** The owner's timezone, for saying when a blob ran and will run. */
  timezone: () => string;
  /** The role's job as the scheduler sees it, when the file gave it one. */
  jobOf: (name: string) => BlobJob | undefined;
  /** Pause or resume the role's job; undefined when it has none. */
  setJobEnabled: (name: string, enabled: boolean) => BlobJob | undefined;
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

/**
 * Whether a blob will run on its own, in the dashboard's words. A schedule
 * in the file says what was asked; only the job says whether it fires.
 */
function stateOf(job: BlobJob | undefined): "scheduled" | "paused" | "on request" {
  return job ? (job.enabled ? "scheduled" : "paused") : "on request";
}

/**
 * The job, as a reader of the list needs it: when it last ran and when it
 * next will, in the owner's words ("today 18:00") with the exact moment
 * beside each, so the model quotes the words and never does the arithmetic.
 */
function runs(job: BlobJob | undefined, timezone: string): Record<string, unknown> {
  if (!job) return {};
  const at = (ms: number): Record<string, string> => ({ words: whenWords(ms, timezone), at: new Date(ms).toISOString() });
  return {
    schedule: job.schedule,
    ...(job.lastRunAt !== null ? { lastRun: at(job.lastRunAt) } : {}),
    ...(job.nextRunAt !== null ? { nextRun: at(job.nextRunAt) } : {}),
  };
}

/** What a role looks like in a list: enough to choose one, not its whole brief. */
function summary(r: RoleRecord, job: BlobJob | undefined, timezone: string): Record<string, unknown> {
  return {
    name: r.name,
    description: r.description,
    tools: r.tools ?? "all",
    memory: r.memory,
    ...(r.task ? { task: r.task } : {}),
    state: stateOf(job),
    ...runs(job, timezone),
    conversationId: agentConversationId(r.name),
    path: r.path,
    folder: r.folder,
  };
}

function defineAgentTools(deps: AgentToolDeps, ctx: ModuleContext): void {
  const from = (): string | undefined => deps.currentConversationId?.();

  ctx.registerTool(
    {
      name: "blobs.list",
      description:
        "The blobs that exist: name, what each is for, what it may reach, and its state: scheduled (it runs on its own, with when it last ran and next will, in the owner's timezone as words to quote), paused (its schedule is off until resumed), or on request (no schedule; it works when dispatched or spoken to). " +
        "Read this before making one, since the responsibility may already have a home.",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const { roles, invalid } = deps.roles.list();
      const timezone = deps.timezone();
      return JSON.stringify({ blobs: roles.map((r) => summary(r, deps.jobOf(r.name), timezone)), ...(invalid.length ? { invalid } : {}) });
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "blobs.create",
      description:
        "Make a blob for a responsibility the owner wants kept: a folder of its own (blobs/<name>/, with blob.md in it, which the owner can read and edit) and a thread of its own. " +
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
          face: {
            type: "object",
            description: "its face, only if the owner asked for a look: hue 0-359, eyes round|half|sparkle, gait 0-3. Otherwise omit; the name decides.",
            properties: { hue: { type: "number" }, eyes: { type: "string", enum: ["round", "half", "sparkle"] }, gait: { type: "number" } },
          },
          replace: { type: "boolean", description: "rewrite a blob that already exists; otherwise an existing name is refused" },
        },
        required: ["name", "description", "brief"],
      },
    },
    (input) => {
      const name = str(input, "name").toLowerCase();
      if (!ROLE_NAME.test(name)) throw new Error(`name must be short and plain, like research or shopper (${ROLE_NAME})`);
      if (deps.roles.exists(name) && input.replace !== true) {
        throw new Error(`there is already a blob called ${name}. Read it with blobs.list; pass replace: true to rewrite it.`);
      }
      const schedule = optional(input, "schedule");
      if (schedule && !cron.validate(schedule)) throw new Error(`not a cron schedule: ${schedule}`);
      const prompt = optional(input, "prompt");
      if (schedule && !prompt) throw new Error("a schedule needs a prompt: what to do on each run");
      const tools = stringList(input.tools);
      const face = parseFaceLook(input.face);
      const role: Role = {
        name,
        description: str(input, "description"),
        brief: str(input, "brief"),
        memory: input.memory === "shared" ? "shared" : "own",
        ...(tools ? { tools } : {}),
        ...(input.task === "cheap" || input.task === "reasoning" ? { task: input.task } : {}),
        ...(schedule ? { schedule } : {}),
        ...(prompt ? { prompt } : {}),
        ...(Object.keys(face).length ? { face } : {}),
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
          ? `Made. It runs on ${job.schedule} in its own thread; dispatch work to it with blobs.dispatch. The owner can edit ${record.path}.`
          : `Made. Dispatch work to it with blobs.dispatch. The owner can edit ${record.path}.`,
      });
    },
    { floor: "safe" },
    { restricted: true },
  );

  ctx.registerTool(
    {
      name: "blobs.dispatch",
      description:
        "Give a task to a blob. At the root it goes to the blob's own thread; from inside a project, or with a project named, the blob gets a chat in that project so what it makes lands there. " +
        "It returns as soon as the work is handed over: say what you delegated and end your turn. The owner is told when it answers.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "the blob's name, from blobs.list" },
          task: { type: "string", description: "the instruction, written the way the owner would say it TO the blob" },
          project: { type: "string", description: "a project slug: run the blob inside that project rather than in its own thread" },
        },
        required: ["agent", "task"],
      },
    },
    async (input) => {
      const name = str(input, "agent").toLowerCase();
      if (!deps.roles.get(name)) throw new Error(`no blob called ${name}; blobs.list says which exist`);
      const task = str(input, "task");
      const here = deps.scope?.();
      const project = optional(input, "project") ?? here;
      // A project orchestrator sends blobs into its own project and no other.
      if (here !== undefined && project !== here) throw new Error(`from this project a blob can only be sent into ${here}`);
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

  // Pausing and resuming are the dashboard's Pause button, for when the
  // owner says it in a chat instead. A blob with no schedule has nothing to
  // pause, and a schedule comes from its file, so that is where to add one.
  const toggle = (tool: "blobs.pause" | "blobs.resume", enabled: boolean, description: string): void => {
    ctx.registerTool(
      {
        name: tool,
        description,
        inputSchema: { type: "object", properties: { name: { type: "string", description: "the blob's name, from blobs.list" } }, required: ["name"] },
      },
      (input) => {
        const name = str(input, "name").toLowerCase();
        if (!deps.roles.get(name)) throw new Error(`no blob called ${name}; blobs.list says which exist`);
        const job = deps.setJobEnabled(name, enabled);
        if (!job) {
          throw new Error(
            enabled
              ? `${name} has no schedule to resume; it works when asked. To give it one, rewrite it with blobs.create (replace: true) with a schedule and a prompt.`
              : `${name} has no schedule to pause; it only works when asked.`,
          );
        }
        return JSON.stringify({
          name,
          state: stateOf(job),
          ...runs(job, deps.timezone()),
          note: enabled ? `Resumed: it runs on ${job.schedule} again.` : "Paused: its schedule is off until resumed. Dispatching to it still works.",
        });
      },
      { floor: "safe" },
      { restricted: true },
    );
  };
  toggle("blobs.pause", false, "Pause a blob's schedule: it stops running on its own until resumed. It can still be dispatched to or spoken to.");
  toggle("blobs.resume", true, "Resume a paused blob's schedule, so it runs on its own again.");

  ctx.registerTool(
    {
      name: "blobs.remove",
      description: "Remove a blob: its file and its schedule. Its thread stays, as an ordinary chat the owner can keep or delete.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    (input) => {
      const name = str(input, "name").toLowerCase();
      if (!deps.roles.remove(name)) throw new Error(`no blob called ${name}`);
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
      name: "blobs",
      version: "1.0.0",
      provides: BLOB_TOOLS.map((name) => ({ kind: "tool" as const, name, version: "1.0.0" })),
      riskTier: "safe",
    },
    activate(ctx) {
      defineAgentTools(deps, ctx);
    },
  };
}
