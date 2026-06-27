import { runAgent, type Inference, type ToolBox } from "../agent/loop.js";
import type { Db } from "../store/db.js";
import { evaluateCondition, queryScope } from "./conditions.js";
import { template, templateArgs } from "./templating.js";
import type { CronJob } from "./types.js";

export interface CronActionResult {
  tool: string;
  content: string;
  isError: boolean;
}

export type CronExecResult =
  | { ran: false; reason: "condition" }
  | { ran: true; type: "actions"; results: CronActionResult[] }
  | { ran: true; type: "self_prompt"; finalText: string };

export interface CronExecutorDeps {
  db: Db;
  /** Tool execution path (guarded in the kernel, so risky actions queue). */
  tools: ToolBox;
  /** Required for self_prompt jobs. */
  inference?: Inference;
  /** Assemble the system context for a self_prompt (manifest + salient memory). */
  buildSystem?: (job: CronJob) => string | undefined;
  maxIterations?: number;
}

/**
 * Execute one cron job. Runs its named query to build the variable scope,
 * evaluates the condition, then either runs the stored tool calls (actions, no
 * LLM) with {var} substitution, or re-enters the agent loop (self_prompt).
 */
export async function runCronJob(
  job: CronJob,
  deps: CronExecutorDeps,
): Promise<CronExecResult> {
  const scope = queryScope(deps.db, job.query);
  if (!evaluateCondition(deps.db, job.condition?.test ?? null, job.query)) {
    return { ran: false, reason: "condition" };
  }

  if (job.type === "actions") {
    const results: CronActionResult[] = [];
    for (const action of job.actions ?? []) {
      const args = templateArgs(action.args, scope);
      const r = await deps.tools.execute(action.tool, args);
      results.push({ tool: action.tool, content: r.content, isError: r.isError });
    }
    return { ran: true, type: "actions", results };
  }

  if (!deps.inference) {
    throw new Error("self_prompt cron requires an inference provider");
  }
  const prompt = template(job.prompt ?? "", scope);
  const system = deps.buildSystem?.(job);
  const result = await runAgent(deps.inference, deps.tools, prompt, {
    task: "reasoning",
    ...(system ? { system } : {}),
    ...(deps.maxIterations ? { maxIterations: deps.maxIterations } : {}),
  });
  return { ran: true, type: "self_prompt", finalText: result.finalText };
}
