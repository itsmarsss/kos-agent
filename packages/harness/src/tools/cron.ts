import { caller } from "../kernel/caller.js";
import cron from "node-cron";

import { CronStore } from "../cron/store.js";
import type { CreateCronInput, ToolCall } from "../cron/types.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `cron` tool module: lets the agent schedule, list, run and remove jobs.
 * Jobs are stored data (a schedule plus actions or a self_prompt); the
 * scheduler runs them. Scheduling and running ask nothing: a job is the
 * owner's own standing instruction, and what a run does is gated when it
 * runs, since an unattended run queues anything risky for the owner and
 * does nothing until they decide. Scheduling used to ask, and so did
 * running a job by hand, which put an approval in front of "remind me every
 * Saturday" while the reminder itself would have asked if it needed to.
 */

export interface CronToolDeps {
  /**
   * Fire a job now, through the same path the schedule uses, so the kill
   * switch, the rate limit, the run log and the health report all see it
   * exactly as they would have at 3am.
   */
  fire?: (id: number) => Promise<{ ok: boolean; error?: string }>;
  /**
   * The project a conversation belongs to, if any. A job scheduled from
   * inside a project's thread is that project's job unless it says
   * otherwise, the way an agent started there is the project's agent.
   */
  projectOf?: (conversationId: string) => string | null;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

function parseSchedule(input: Record<string, unknown>): CreateCronInput {
  const schedule = str(input, "schedule");
  if (!cron.validate(schedule)) {
    throw new Error(`invalid cron schedule: ${schedule}`);
  }
  const type = input.type === "self_prompt" ? "self_prompt" : "actions";
  const base: CreateCronInput = { name: str(input, "name"), schedule, type };
  if (typeof input.query === "string") base.query = input.query;
  if (input.condition && typeof input.condition === "object") {
    const test = (input.condition as { test?: unknown }).test;
    if (typeof test === "string") base.condition = { test };
  }
  if (type === "actions") {
    base.actions = parseActions(input.actions);
  } else {
    base.prompt = str(input, "prompt");
  }
  // Either kind can be a project's: a self_prompt runs in its context, and
  // an actions job that works its tables belongs with it just the same.
  if (typeof input.projectSlug === "string" && input.projectSlug) base.projectSlug = input.projectSlug;
  return base;
}

/**
 * Check the action list rather than casting it.
 *
 * An unchecked cast let a job be stored in whatever shape the model imagined,
 * approved by the owner, and then fail every morning at nine with nobody
 * watching. A schedule that cannot run should be refused when it is written.
 */
function parseActions(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      'an actions job needs a non-empty "actions" array of {tool, args}',
    );
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`actions[${i}] must be an object {tool, args}`);
    }
    const call = entry as Record<string, unknown>;
    if (typeof call["tool"] !== "string" || call["tool"] === "") {
      throw new Error(
        `actions[${i}] needs "tool", the tool name as a string. Got keys: ${
          Object.keys(call).join(", ") || "(none)"
        }`,
      );
    }
    const args = call["args"];
    if (
      args !== undefined &&
      (typeof args !== "object" || args === null || Array.isArray(args))
    ) {
      throw new Error(`actions[${i}]: "args" must be an object of arguments`);
    }
    return {
      tool: call["tool"],
      args: (args as Record<string, unknown> | undefined) ?? {},
    };
  });
}

export const cronModule: KosModule = {
  manifest: {
    name: "cron",
    version: "1.0.0",
    provides: [
      { kind: "tool", name: "cron.schedule", version: "1.0.0" },
      { kind: "tool", name: "cron.list", version: "1.0.0" },
      { kind: "tool", name: "cron.remove", version: "1.0.0" },
    ],
    riskTier: "risky",
  },
  activate(ctx) {
    activate(ctx, {});
  },
};

function activate(ctx: ModuleContext, deps: CronToolDeps): void {
  const { db } = requireServices(ctx);
  const store = new CronStore(db);

  ctx.registerTool(
    {
      name: "cron.schedule",
      description:
        "Schedule a job: a cron expression plus either actions (tool calls) or a self_prompt.\n" +
        'actions is a list of literal calls: [{"tool":"notify","args":{"text":"..."}}], run in order. An action cannot see what an earlier one returned. What it can see is the job\'s query: SQL whose first row is the scope, and {column} in any string argument (or in a self_prompt) is replaced by that column, read again before each action; the condition\'s test runs over the same row. ' +
        "So an action can say what an earlier action left in a table.\n" +
        "Anything that has to read data and reason about it is a self_prompt job. " +
        "A job that needs no judgment should not spend a model turn: write a script skill (skills.create) that leaves what it found in a table (process.env.KOS_DB is the workspace database; node:sqlite reads and writes it), promote it once (skills.promote), and schedule one actions job: skills.run with its name, then the action that uses the row through the query, such as notify with {text}. A promoted skill runs without asking, so the run costs nothing but the script.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          schedule: { type: "string" },
          type: { type: "string", enum: ["actions", "self_prompt"] },
          query: { type: "string" },
          condition: { type: "object" },
          actions: {
            type: "array",
            description:
              'literal tool calls, e.g. [{"tool":"notify","args":{"text":"stand up"}}]',
            items: {
              type: "object",
              properties: {
                tool: { type: "string" },
                args: { type: "object" },
              },
              required: ["tool"],
            },
          },
          prompt: { type: "string" },
          projectSlug: { type: "string" },
        },
        required: ["name", "schedule"],
      },
    },
    (input) => {
      const parsed = parseSchedule(input);
      // Scheduled from a project's thread, it is the project's job.
      const from = caller.getStore();
      if (!parsed.projectSlug && from && deps.projectOf) {
        const slug = deps.projectOf(from);
        if (slug) parsed.projectSlug = slug;
      }
      const job = store.create(parsed);
      return JSON.stringify({ id: job.id, name: job.name, ...(job.projectSlug ? { projectSlug: job.projectSlug } : {}) });
    },
    { floor: "safe" },
  );

  ctx.registerTool(
    {
      name: "cron.list",
      description: "List scheduled jobs.",
      inputSchema: { type: "object", properties: {} },
    },
    () =>
      JSON.stringify(
        store.list().map((j) => ({
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          type: j.type,
          enabled: j.enabled,
        })),
      ),
    { floor: "safe" },
  );

  ctx.registerTool(
    {
      name: "cron.remove",
      description: "Delete a scheduled job by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    },
    (input) => {
      const id = typeof input.id === "number" ? input.id : Number(input.id);
      return store.delete(id) ? "removed" : "not found";
    },
    { floor: "safe" },
  );

  if (!deps.fire) return;
  const fire = deps.fire;

  ctx.registerTool(
    {
      name: "cron.run",
      description:
        "Run a scheduled job now, without waiting for its schedule. The answer says " +
        "whether it worked, not merely whether it started, so a job whose actions all " +
        "failed reads as a failure. Use it to check a job does what it should rather " +
        "than finding out at 3am.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    },
    async (input) => {
      const id = typeof input.id === "number" ? input.id : Number(input.id);
      const job = store.get(id);
      if (!job) throw new Error(`no such cron: ${id}`);
      const result = await fire(id);
      return result.ok
        ? `ran ${job.name}`
        : `${job.name} did not succeed: ${result.error ?? "unknown error"}`;
    },
    { floor: "safe" },
  );
}

/** The module with a way to fire a job by hand. */
export function createCronModule(deps: CronToolDeps = {}): KosModule {
  return {
    ...cronModule,
    manifest: {
      ...cronModule.manifest,
      provides: [
        ...cronModule.manifest.provides,
        ...(deps.fire
          ? [{ kind: "tool" as const, name: "cron.run", version: "1.0.0" }]
          : []),
      ],
    },
    activate: (ctx) => activate(ctx, deps),
  };
}
