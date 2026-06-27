/**
 * Cron jobs are stored data, not a custom file format: a schedule plus either a
 * list of tool calls (actions) or a self-prompt. The LLM already speaks tool
 * calls and JSON, so there is nothing new to learn.
 */

export type CronType = "actions" | "self_prompt";

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** A boolean SQL expression evaluated over the job's query scope before running. */
export interface CronCondition {
  test: string;
}

export interface CronJob {
  id: number;
  name: string;
  /** Standard cron expression. */
  schedule: string;
  type: CronType;
  /** SQL whose first result row is the variable scope for condition + templating. */
  query: string | null;
  condition: CronCondition | null;
  /** Tool calls for `actions` jobs. */
  actions: ToolCall[] | null;
  /** Prompt for `self_prompt` jobs. */
  prompt: string | null;
  /** Project context for a self_prompt (manifest + salient memory). */
  projectSlug: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCronInput {
  name: string;
  schedule: string;
  type: CronType;
  query?: string;
  condition?: CronCondition;
  actions?: ToolCall[];
  prompt?: string;
  projectSlug?: string;
  enabled?: boolean;
}
