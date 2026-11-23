import type { CronJob, RunRecord } from "./api.js";

/**
 * The chat a run was written into, while it is still there: a turn's own
 * chat, or a schedule's thread (a blob's schedule runs in the blob's).
 * Runs named their schedule and nothing else, so reading what a run said
 * meant finding its thread by hand.
 */
export function runChat(run: Pick<RunRecord, "kind" | "ref">, crons: readonly Pick<CronJob, "id" | "conversationId">[], chats: ReadonlySet<string>): string | undefined {
  const id = run.kind === "chat" ? run.ref : run.kind === "cron" ? crons.find((c) => String(c.id) === run.ref)?.conversationId : undefined;
  return id && chats.has(id) ? id : undefined;
}
