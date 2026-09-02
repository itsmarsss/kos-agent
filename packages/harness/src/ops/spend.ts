import type { Db } from "../store/db.js";

/**
 * What KOS has spent, in tokens.
 *
 * Both providers already report usage on every response and it was being
 * dropped on the floor, so there was no way to answer "what is this costing
 * me" short of opening a billing page. This records it.
 *
 * Tokens are the authoritative part: they are counted by the provider and
 * stored as given. Money is not, and is deliberately not guessed at. Prices
 * change, differ by tier and by account, and a dollar figure built from a
 * hardcoded table would go quietly wrong rather than loudly wrong. So a rate
 * is something the owner sets, and a cost is only ever shown for a model they
 * have set one for.
 */

export interface UsageRecord {
  at: number;
  /** Conversation this was spent on, when it was spent on one. */
  conversationId: string | null;
  /** Routed task, e.g. "reasoning" or "cheap". */
  task: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelTotal {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface ModelDayTotal {
  provider: string;
  model: string;
  day: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface DayTotal {
  /** YYYY-MM-DD, local time, because that is the day the owner had. */
  day: string;
  inputTokens: number;
  outputTokens: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  conversation_id TEXT,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_at ON token_usage (at);
CREATE INDEX IF NOT EXISTS idx_token_usage_conversation
  ON token_usage (conversation_id, at);
`;

export class SpendStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(SCHEMA);
  }

  record(input: Omit<UsageRecord, "at"> & { at?: number }): void {
    // A response with no usage reported is not worth a row: it would show as a
    // call that cost nothing, which is a claim rather than an absence.
    if (input.inputTokens === 0 && input.outputTokens === 0) return;
    this.db
      .prepare(
        `INSERT INTO token_usage
           (at, conversation_id, task, provider, model, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.at ?? this.now(),
        input.conversationId ?? null,
        input.task,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
      );
  }

  /** Totals per model, newest window first. `since` is a timestamp. */
  byModel(since = 0): ModelTotal[] {
    return this.db
      .prepare(
        // Aliased to the field names the type promises. Casting the raw rows
        // instead left inputTokens undefined everywhere the type said it was a
        // number, which reaches the dashboard as a blank rather than an error.
        `SELECT provider, model,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                COUNT(*) AS calls
         FROM token_usage WHERE at >= ?
         GROUP BY provider, model
         ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`,
      )
      .all(since) as unknown as ModelTotal[];
  }

  /**
   * Daily totals per model, oldest first.
   *
   * The table says a model cost you a figure over thirty days, which is the
   * one number you cannot act on: it does not say whether that was steady or
   * one bad afternoon.
   */
  byModelDay(since = 0): ModelDayTotal[] {
    return this.db
      .prepare(
        `SELECT provider, model,
                date(at / 1000, 'unixepoch', 'localtime') AS day,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                COUNT(*) AS calls
         FROM token_usage WHERE at >= ?
         GROUP BY provider, model, day
         ORDER BY day`,
      )
      .all(since) as unknown as ModelDayTotal[];
  }

  /** Daily totals, oldest first, for a simple trend. */
  byDay(since = 0): DayTotal[] {
    return this.db
      .prepare(
        `SELECT date(at / 1000, 'unixepoch', 'localtime') AS day,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens
         FROM token_usage WHERE at >= ?
         GROUP BY day ORDER BY day`,
      )
      .all(since) as unknown as DayTotal[];
  }

  /**
   * What the last turn in a conversation put in front of the model.
   *
   * This is the honest measure of context used: the provider's own count of
   * the tokens it was sent, rather than an estimate from character counts.
   */
  lastContext(
    conversationId: string,
  ): { inputTokens: number; provider: string; model: string; at: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT input_tokens, provider, model, at FROM token_usage
         WHERE conversation_id = ? ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(conversationId) as
      | { input_tokens: number; provider: string; model: string; at: number }
      | undefined;
    return row
      ? {
          inputTokens: row.input_tokens,
          provider: row.provider,
          model: row.model,
          at: row.at,
        }
      : undefined;
  }

  /** Everything spent on one conversation. */
  forConversation(conversationId: string): {
    inputTokens: number;
    outputTokens: number;
    calls: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COUNT(*) AS calls
         FROM token_usage WHERE conversation_id = ?`,
      )
      .get(conversationId) as {
      input_tokens: number;
      output_tokens: number;
      calls: number;
    };
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      calls: row.calls,
    };
  }
}

/** Owner-set facts about a model, keyed by `provider:model`. */
export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
  /**
   * Context window, when the owner knows it and KOS does not.
   *
   * Same reasoning as the price: a window built into the code goes quietly
   * wrong for a model released after it was written, and a wrong window reads
   * as "12% used" when the truth is 60%. Set here, it is a fact the owner
   * vouched for rather than one this code guessed.
   */
  contextWindow?: number;
}

export type Rates = Record<string, ModelRate>;

export const RATES_KEY = "spend.rates";

/** Cost of a model's usage, or undefined when no rate has been set for it. */
export function costOf(
  total: { provider: string; model: string; inputTokens: number; outputTokens: number },
  rates: Rates,
): number | undefined {
  const rate = rates[`${total.provider}:${total.model}`] ?? rates[total.model];
  if (!rate) return undefined;
  return (
    (total.inputTokens / 1_000_000) * rate.inputPerMillion +
    (total.outputTokens / 1_000_000) * rate.outputPerMillion
  );
}

/** Parse rates off the wire, dropping anything that is not a pair of numbers. */
export function parseRates(raw: unknown): Rates {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Rates = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const input = Number(v["inputPerMillion"]);
    const output = Number(v["outputPerMillion"]);
    // A negative or non-finite rate would produce a confident wrong number,
    // which is worse than showing no number at all.
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    if (input < 0 || output < 0) continue;
    const window = Number(v["contextWindow"]);
    out[key] = {
      inputPerMillion: input,
      outputPerMillion: output,
      ...(Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
    };
  }
  return out;
}

/**
 * The context window to use for a model: what the owner set, else what is
 * known, else nothing. The owner's answer wins because they can see the
 * provider's current documentation and this code cannot.
 */
export function windowFor(
  provider: string,
  model: string,
  rates: Rates,
  known: (model: string) => number | undefined,
): number | undefined {
  const set = rates[`${provider}:${model}`]?.contextWindow ?? rates[model]?.contextWindow;
  return set ?? known(model);
}
