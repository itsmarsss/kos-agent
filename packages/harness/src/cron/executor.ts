import { runAgent, type Inference, type ToolBox } from "../agent/loop.js";
import { NO_STEPS, outcomeOf, type RunOutcome, type StepTally } from "../ops/outcome.js";
import type { Db } from "../store/db.js";
import { evaluateCondition, queryScope, readerOf } from "./conditions.js";
import { template, templateArgs } from "./templating.js";
import type { CronJob } from "./types.js";

export interface CronActionResult {
  tool: string;
  /** What it ran with, after templating, so a run can be read back. */
  args?: Record<string, unknown>;
  content: string;
  isError: boolean;
}

/** A self-prompt job's turn, as far as it went. */
export interface JobTurn {
  reply: string;
  steps: StepTally;
  /** The notify calls it made that ran and worked: what it delivered. */
  delivered: number;
  /** The quiet endings it declared with notify: a run that chose, and said, to post nothing this time. */
  quiet: number;
  /** Why it ended without its reply, when it did. */
  stopped?: string;
}

export interface SelfPromptResult {
  ran: true;
  type: "self_prompt";
  finalText: string;
  steps: StepTally;
  /** Why the turn ended without its reply, when it did. */
  stopped?: string;
  /** Why the job, written to post with notify, posted nothing and did not say it chose to. */
  undelivered?: string;
  /** The turn is waiting on the owner: how it ends, once it does. The run is judged on that, not on this. */
  later?: Promise<SelfPromptResult>;
}

export type CronExecResult =
  | { ran: false; reason: "condition" | "no-agent" }
  | { ran: true; type: "actions"; results: CronActionResult[] }
  | SelfPromptResult;

export interface CronExecutorDeps {
  db: Db;
  /** Judges each statement the job's query and condition run, throwing to refuse: the fence for the job's project. */
  check?: (sql: string) => void;
  /** Tool execution path (guarded in the kernel, so risky actions queue). */
  tools: ToolBox;
  /** Required for self_prompt jobs. */
  inference?: Inference;
  /** Assemble the system context for a self_prompt (manifest + salient memory). */
  buildSystem?: (job: CronJob) => string | undefined | Promise<string | undefined>;
  /**
   * Run the prompt as a turn in the job's conversation, and give back what it
   * said. Absent for a caller with no conversations, such as a test.
   */
  runInConversation?: (prompt: string, job: CronJob) => Promise<JobTurn & { later?: Promise<JobTurn> }>;
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
  const read = readerOf(deps.db, deps.check);
  const scope = queryScope(read, job.query);
  if (!evaluateCondition(read, job.condition?.test ?? null, job.query)) {
    return { ran: false, reason: "condition" };
  }

  if (job.type === "actions") {
    const results: CronActionResult[] = [];
    for (const action of job.actions ?? []) {
      // The scope is read again for each action, so an action can use what
      // an earlier one left in a table: a script that writes today's post,
      // then a notify that says it. Read once up front, the second action
      // saw yesterday's row.
      const args = templateArgs(action.args, queryScope(read, job.query));
      const r = await deps.tools.execute(action.tool, args);
      results.push({
        tool: action.tool,
        args,
        content: r.content,
        isError: r.isError,
      });
    }
    return { ran: true, type: "actions", results };
  }

  if (!deps.inference) {
    throw new Error("self_prompt cron requires an inference provider");
  }
  const prompt = template(job.prompt ?? "", scope);

  /*
   * In the job's own conversation, where there is one.
   *
   * Running the model directly left nothing behind: no transcript, no live
   * view, and nothing to ask afterwards. A turn in a conversation is watched,
   * questioned and re-read with the machinery that already exists for one.
   */
  if (deps.runInConversation) {
    const { later, ...turn } = await deps.runInConversation(prompt, job);
    if (!later) return selfPromptResult(job, turn);
    return { ran: true, type: "self_prompt", finalText: turn.reply, steps: turn.steps, later: later.then((end) => selfPromptResult(job, end)) };
  }

  const system = await deps.buildSystem?.(job);
  const result = await runAgent(deps.inference, deps.tools, prompt, {
    task: "reasoning",
    ...(system ? { system } : {}),
    ...(deps.maxIterations ? { maxIterations: deps.maxIterations } : {}),
  });
  return { ran: true, type: "self_prompt", finalText: result.finalText, steps: NO_STEPS };
}

/** A job written to post with notify: one that ends having posted nothing, and not saying it chose to, did not do what it is for. */
export function asksToNotify(job: Pick<CronJob, "prompt">): boolean {
  return /\bnotify\b/i.test(job.prompt ?? "");
}

/**
 * A finished turn as the job's result: whether it was cut short, and whether
 * it delivered what it was written to. A job that posts only when there is
 * news ends most runs with nothing to say; its quiet ending (notify with
 * quiet) says so, and is what tells that from a message never sent.
 */
export function selfPromptResult(job: Pick<CronJob, "prompt">, turn: JobTurn): SelfPromptResult {
  return {
    ran: true,
    type: "self_prompt",
    finalText: turn.reply,
    steps: turn.steps,
    ...(turn.stopped ? { stopped: turn.stopped } : {}),
    ...(turn.stopped ? {} : undeliveredBy(job, turn)),
  };
}

/**
 * Why a job written to post with notify did not, when it did not.
 *
 * A quiet ending stands only over a run where nothing else failed: one
 * whose post was refused, or whose work failed, that then ends quietly has
 * not chosen silence, it has hidden the failure, and a run where only some
 * steps failed would otherwise read as healthy.
 */
function undeliveredBy(job: Pick<CronJob, "prompt">, turn: JobTurn): { undelivered?: string } {
  if (!asksToNotify(job) || turn.delivered > 0) return {};
  const why = turn.steps.firstError ? `: ${turn.steps.firstError}` : ".";
  if (turn.quiet === 0) return { undelivered: `It was written to post with notify, and posted nothing${why}` };
  return turn.steps.failed > 0 ? { undelivered: `It ended without posting after a step failed${why}` } : {};
}

/**
 * How a run went: from its steps, never from its reply.
 *
 * An action that errors does not throw: it comes back with isError set, and
 * a job whose every step failed would otherwise be indistinguishable from a
 * clean run. A self-prompt job is the same: its turn replies "Done." over
 * steps that all failed. Written once because the scheduled path and the
 * run-it-now path must agree on what "failed" means, and they did not.
 */
export function cronOutcome(result: CronExecResult): RunOutcome | { status: "skipped"; error: null } {
  if (!result.ran) return { status: "skipped", error: null };
  if (result.type === "self_prompt") {
    if (result.stopped) return { status: "error", error: `Stopped before it finished: ${result.stopped}` };
    if (result.undelivered) return { status: "error", error: result.undelivered };
    return outcomeOf(result.steps, true);
  }
  // A stored action is a step the job was written to take: any that fails, fails the run.
  const failed = result.results.find((r) => r.isError);
  return failed ? { status: "error", error: `${failed.tool}: ${failed.content}` } : { status: "ok", error: null };
}

/** The failure of a run that failed, for the run-it-now answer and the health report; null for any other. */
export function cronFailure(result: CronExecResult): string | null {
  const outcome = cronOutcome(result);
  return outcome.status === "error" ? outcome.error : null;
}
