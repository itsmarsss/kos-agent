import { allowsTool, caller, guestCannot, scopeAllow } from "../kernel/caller.js";
import cron from "node-cron";

import { conditionSql } from "../cron/conditions.js";
import { CronStore } from "../cron/store.js";
import type { CreateCronInput, ToolCall } from "../cron/types.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";
import { fence } from "./fence.js";
import { reachOf } from "./sql.js";

/**
 * The `cron` tool module: lets the agent schedule, list, run and remove jobs.
 * Jobs are stored data (a schedule plus actions or a self_prompt); the
 * scheduler runs them. Scheduling in a chat's own project and running ask
 * nothing: what a run does is gated when it runs, since an unattended run
 * queues anything risky for the owner and does nothing until they decide.
 * A job is held to what the chat that made it could do: its project's
 * tables through the sql fence for its query and condition (judged now and
 * again on every run), and the chat's allow-list for its actions and its
 * turns. Scheduling as another project asks the owner, and never under Auto.
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

/** The project the calling chat is in, when it is in one. */
function callerProjectOf(deps: CronToolDeps): string | null {
  const from = caller.getStore();
  return from && deps.projectOf ? deps.projectOf(from) : null;
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
      const own = callerProjectOf(deps);
      if (!parsed.projectSlug && own) parsed.projectSlug = own;
      // What the chat may do is all its job may: its actions are tools it has, and the job keeps its list.
      const allow = scopeAllow();
      for (const action of parsed.actions ?? []) {
        if (!allowsTool(allow, action.tool)) throw new Error(`${action.tool} is not a tool this chat has, so a job of its own cannot call it either`);
      }
      if (allow !== undefined) parsed.toolAllow = [...allow];
      // Its reads judged as its runs will be: the sql fence, for the job's project.
      const reach = { ...reachOf(ctx), project: parsed.projectSlug, owner: false, made: [] };
      for (const sql of [parsed.query, parsed.condition ? conditionSql(parsed.condition.test, parsed.query ?? null) : undefined]) {
        if (!sql) continue;
        const verdict = fence(db, sql, reach);
        if (!verdict.ok) throw new Error(`the job's ${sql === parsed.query ? "query" : "condition"} is refused: ${verdict.reason}`);
      }
      const job = store.create(parsed);
      return JSON.stringify({ id: job.id, name: job.name, ...(job.projectSlug ? { projectSlug: job.projectSlug } : {}) });
    },
    {
      floor: "safe",
      refuse: () => guestCannot("A schedule"),
      // Work set up to run as another project, Maintenance included, is the owner's to allow; never Auto's (beyondauto.ts).
      escalate: (input) => {
        const asked = typeof input.projectSlug === "string" && input.projectSlug ? input.projectSlug : null;
        return asked !== null && asked !== callerProjectOf(deps) ? `schedules work to run as the ${asked} project, not this chat's own` : false;
      },
      // The schedule is the point: once its chat has stopped, a yes still makes it, its card warning so.
      detached: "runs",
    },
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
    { floor: "safe", refuse: () => guestCannot("Removing a schedule") },
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
    { floor: "safe", refuse: () => guestCannot("Running a schedule") },
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
