import cron from "node-cron";

import { CronStore } from "../cron/store.js";
import type { CreateCronInput, ToolCall } from "../cron/types.js";
import type { KosModule } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `cron` tool module: lets the agent schedule, list, and remove jobs. Jobs
 * are stored data (a schedule plus actions or a self_prompt); the scheduler runs
 * them. Scheduling is risky-tier, so a new job goes to approval before it can
 * fire unattended. Listing and removing are safe.
 */

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
    if (!Array.isArray(input.actions)) {
      throw new Error("actions job requires an actions array");
    }
    base.actions = input.actions as ToolCall[];
  } else {
    base.prompt = str(input, "prompt");
    if (typeof input.projectSlug === "string") base.projectSlug = input.projectSlug;
  }
  return base;
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
    const { db } = requireServices(ctx);
    const store = new CronStore(db);

    ctx.registerTool(
      {
        name: "cron.schedule",
        description:
          "Schedule a job: a cron expression plus either actions (tool calls) or a self_prompt. New jobs require approval before running.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            schedule: { type: "string" },
            type: { type: "string", enum: ["actions", "self_prompt"] },
            query: { type: "string" },
            condition: { type: "object" },
            actions: { type: "array" },
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
  },
};
