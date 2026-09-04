import cron from "node-cron";

import { CronStore } from "../cron/store.js";
import type { CreateCronInput, ToolCall } from "../cron/types.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `cron` tool module: lets the agent schedule, list, run and remove jobs.
 * Jobs are stored data (a schedule plus actions or a self_prompt); the
 * scheduler runs them. Scheduling is risky-tier, so a new job goes to approval
 * before it can fire unattended. Listing and removing are safe.
 *
 * cron.run is risky for a different reason from cron.schedule. Firing a job
 * runs whatever that job holds -- a write, a message to a channel -- and the
 * risk gate cannot see any of it from the arguments to this call, which are
 * only an id. So the decision is put to the owner at the point where the
 * consequences are still knowable: the job, by name.
 */

export interface CronToolDeps {
  /**
   * Fire a job now, through the same path the schedule uses, so the kill
   * switch, the rate limit, the run log and the health report all see it
   * exactly as they would have at 3am.
   */
  fire?: (id: number) => Promise<{ ok: boolean; error?: string }>;
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
    if (typeof input.projectSlug === "string")
      base.projectSlug = input.projectSlug;
  }
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
        "Schedule a job: a cron expression plus either actions (tool calls) or a self_prompt. New jobs require approval before running.\n" +
        'actions is a list of literal calls: [{"tool":"notify","args":{"text":"..."}}]. They run in order and nothing is substituted into them: an action cannot see what an earlier one returned, and there is no {{placeholder}} syntax.\n' +
        "So anything that has to read data and then say something about it is a self_prompt job, not an actions job. Use actions only for calls whose arguments are known when you schedule them.",
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
      const job = store.create(parseSchedule(input));
      return JSON.stringify({ id: job.id, name: job.name });
    },
    { floor: "risky" },
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
    { floor: "risky" },
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
