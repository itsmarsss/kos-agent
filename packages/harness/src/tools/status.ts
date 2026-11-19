import type { KosModule, ModuleContext } from "../modules/loader.js";
import { guestOrigin } from "../kernel/caller.js";
import type { ApprovalQueue } from "../ops/approvals.js";
import type { RunsLog } from "../ops/runs.js";
import { costOf, sumSpend, type Rates, type SpendStore } from "../ops/spend.js";
import { scrubShapes } from "../secrets/shapes.js";

/**
 * `kos.status`: KOS's own health, in summaries, for any chat but a guest's.
 *
 * KOS's tables (the run log, the approval queue, token usage) are fenced off
 * from `sql` outside Maintenance, so a daily kickoff asking what failed
 * overnight got a refusal and an empty line. This answers that question
 * from the stores themselves, and only in counts and names: no message
 * text, no tool arguments, nothing of a chat but how its runs went. A cron
 * failure carries the first line of its error, which is KOS's own words
 * about its own job, scrubbed and cut short.
 */

export const STATUS_TOOL = "kos.status";

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;
const ERROR_CAP = 200;
const HOUR_MS = 60 * 60_000;

/** Dollars to a hundredth of a cent: enough for a summary, short enough to read. */
const usd = (n: number | undefined): number | null => (n === undefined ? null : Math.round(n * 10_000) / 10_000);

export interface StatusToolDeps {
  runs: Pick<RunsLog, "since">;
  approvals: Pick<ApprovalQueue, "pending">;
  spend: Pick<SpendStore, "byModel">;
  /** The owner's rates, read at call time so a change in Settings counts at once. */
  rates: () => Rates;
  /** A job's name by its id; undefined for one deleted since it ran. */
  jobName: (id: number) => string | undefined;
  now?: () => number;
}

interface KindCounts {
  ok: number;
  error: number;
}

interface CronFailure {
  jobId: number;
  job: string | null;
  at: string;
  error: string;
}

/** The window asked for, in hours: 24 unless said, never past a week. */
function hoursOf(input: Record<string, unknown>): number {
  if (input.hours === undefined) return DEFAULT_HOURS;
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("hours must be a positive number");
  return Math.min(hours, MAX_HOURS);
}

/** An error's first line with anything key- or card-shaped masked, short enough for a summary. */
function errorLine(error: string | null): string {
  const first = (error ?? "").split("\n").find((line) => line.trim())?.trim() ?? "unknown error";
  const line = scrubShapes(first).text;
  return line.length > ERROR_CAP ? `${line.slice(0, ERROR_CAP - 1)}…` : line;
}

function runsIn(deps: StatusToolDeps, since: number) {
  const kinds: Record<string, KindCounts> = {};
  const cronFailures: CronFailure[] = [];
  for (const run of deps.runs.since(since)) {
    if (run.status !== "ok" && run.status !== "error") continue;
    const counts = (kinds[run.kind] ??= { ok: 0, error: 0 });
    counts[run.status] += 1;
    if (run.status !== "error" || run.kind !== "cron") continue;
    const jobId = Number(run.ref);
    cronFailures.push({
      jobId,
      job: deps.jobName(jobId) ?? null,
      at: new Date(run.finishedAt ?? run.startedAt).toISOString(),
      error: errorLine(run.error),
    });
  }
  return { kinds, cronFailures };
}

function approvalsNow(deps: StatusToolDeps, now: number) {
  const pending = deps.approvals.pending();
  const oldest = pending.reduce<(typeof pending)[number] | undefined>(
    (first, action) => (!first || action.requestedAt < first.requestedAt ? action : first),
    undefined,
  );
  return {
    pending: pending.length,
    oldest: oldest ? { tool: oldest.tool, ageMinutes: Math.max(0, Math.floor((now - oldest.requestedAt) / 60_000)) } : null,
  };
}

function usageIn(deps: StatusToolDeps, since: number) {
  const rates = deps.rates();
  const totals = deps.spend.byModel(since);
  const models = totals.map((t) => ({
    model: `${t.provider}:${t.model}`,
    calls: t.calls,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    // Null rather than zero: a model the owner has not priced has an unknown cost, not a free one.
    costUSD: usd(costOf(t, rates)),
  }));
  const sum = (key: "cacheReadTokens" | "cacheCreationTokens"): number => totals.reduce((n, t) => n + t[key], 0);
  const { calls, inputTokens, outputTokens, cost } = sumSpend(totals, rates);
  const unpriced = models.filter((m) => m.costUSD === null).map((m) => m.model);
  return {
    models,
    total: {
      calls,
      inputTokens,
      outputTokens,
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      // A sum over the priced models alone is not the figure, so one unpriced model leaves it null.
      costUSD: totals.length ? usd(cost) : 0,
      ...(unpriced.length ? { unpriced } : {}),
    },
  };
}

export function createStatusModule(deps: StatusToolDeps): KosModule {
  const now = deps.now ?? Date.now;
  return {
    manifest: {
      name: "kos",
      version: "1.0.0",
      provides: [{ kind: "tool", name: STATUS_TOOL, version: "1.0.0" }],
      riskTier: "safe",
    },
    activate(ctx: ModuleContext) {
      ctx.registerTool(
        {
          name: STATUS_TOOL,
          description:
            "KOS's own health over the last hours (24 unless said, at most 168): runs by kind with how many went ok and how many failed, " +
            "each failed scheduled job with its id, name, time and the first line of its error; pending approvals, how many and the oldest one's tool and age; " +
            "and tokens per provider:model with the estimated cost at the owner's rates (null for a model with no rate), plus a total. " +
            "Use it for anything about failed runs, waiting approvals or what KOS has spent; KOS's own tables are not reachable through sql.",
          inputSchema: {
            type: "object",
            properties: {
              hours: { type: "number", description: `the window, in hours back from now; default ${DEFAULT_HOURS}, at most ${MAX_HOURS}` },
            },
          },
        },
        (input) => {
          const hours = hoursOf(input);
          const at = now();
          const since = at - hours * HOUR_MS;
          return JSON.stringify({
            window: { hours, since: new Date(since).toISOString() },
            runs: runsIn(deps, since),
            approvals: approvalsNow(deps, at),
            usage: usageIn(deps, since),
          });
        },
        {
          floor: "safe",
          refuse: () => (guestOrigin() ? "KOS's health is the owner's to read, and a guest's words started this work." : false),
        },
      );
    },
  };
}
