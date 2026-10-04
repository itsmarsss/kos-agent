import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { contextWindowFor } from "../models/windows.js";
import { costOf, parseRates, SpendStore } from "./spend.js";

describe("what KOS has spent", () => {
  let root: string;
  let ws: Workspace;
  let spend: SpendStore;
  let clock: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-spend-"));
    ws = Workspace.open(root);
    clock = Date.UTC(2026, 7, 31, 12, 0, 0);
    spend = new SpendStore(ws.db, () => clock);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const usage = (over: Partial<Parameters<SpendStore["record"]>[0]> = {}): void =>
    spend.record({
      conversationId: "chat:1",
      task: "reasoning",
      provider: "openai",
      model: "gpt-5.6-terra",
      inputTokens: 1000,
      outputTokens: 200,
      ...over,
    });

  describe("recording", () => {
    it("totals per model", () => {
      usage();
      usage({ outputTokens: 300 });
      usage({ provider: "anthropic", model: "claude-opus-4-8", inputTokens: 50, outputTokens: 5 });

      const totals = spend.byModel();
      expect(totals).toHaveLength(2);
      // Biggest first, so the thing costing the money is the thing you read.
      expect(totals[0]?.model).toBe("gpt-5.6-terra");
      expect(totals[0]?.inputTokens).toBe(2000);
      expect(totals[0]?.outputTokens).toBe(500);
      expect(totals[0]?.calls).toBe(2);
    });

    /*
     * A response that reported nothing is an absence, not a free call. Storing
     * it would show as a call that cost zero, which is a claim.
     */
    it("prices the owner's own model once a rate is set, never before", () => {
      const used = { provider: "custom", model: "local-7b", inputTokens: 1_000_000, outputTokens: 500_000 };
      expect(costOf(used, {})).toBeUndefined();
      expect(costOf(used, { "custom:local-7b": { inputPerMillion: 0.2, outputPerMillion: 0.6 } })).toBeCloseTo(0.5);
    });

    it("does not record a response that reported no usage", () => {
      usage({ inputTokens: 0, outputTokens: 0 });
      expect(spend.byModel()).toEqual([]);
    });

    it("keeps usage with no conversation to attribute it to", () => {
      usage({ conversationId: null, task: "cheap" });
      expect(spend.byModel()[0]?.calls).toBe(1);
    });

    it("only counts inside the window asked for", () => {
      usage();
      clock += 10 * 24 * 60 * 60 * 1000;
      usage({ inputTokens: 7 });
      expect(spend.byModel(clock - 24 * 60 * 60 * 1000)[0]?.inputTokens).toBe(7);
    });
  });

  describe("per conversation", () => {
    it("reports the last turn's input as the context used", () => {
      usage({ inputTokens: 1000 });
      clock += 1000;
      usage({ inputTokens: 4500 });
      // Not a sum: context used is what the most recent turn was sent, which
      // is the number that says how full the window is.
      expect(spend.lastContext("chat:1")?.inputTokens).toBe(4500);
      expect(spend.lastContext("chat:1")?.model).toBe("gpt-5.6-terra");
    });

    it("totals everything spent on one conversation", () => {
      usage();
      usage();
      usage({ conversationId: "chat:2" });
      const total = spend.forConversation("chat:1");
      expect(total).toEqual({ inputTokens: 2000, outputTokens: 400, calls: 2 });
    });

    it("says nothing rather than zero for a conversation with no turns", () => {
      expect(spend.lastContext("chat:none")).toBeUndefined();
      expect(spend.forConversation("chat:none").calls).toBe(0);
    });
  });

  describe("cost", () => {
    /*
     * Prices are the owner's, never guessed. A model nobody has priced has an
     * unknown cost, which must not be rendered as a confident $0.00.
     */
    it("has no cost for a model with no rate set", () => {
      const total = {
        provider: "openai",
        model: "gpt-5.6-terra",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      };
      expect(costOf(total, {})).toBeUndefined();
    });

    it("prices input and output separately", () => {
      const total = {
        provider: "openai",
        model: "gpt-5.6-terra",
        inputTokens: 2_000_000,
        outputTokens: 500_000,
      };
      const rates = {
        "openai:gpt-5.6-terra": { inputPerMillion: 1.25, outputPerMillion: 10 },
      };
      expect(costOf(total, rates)).toBeCloseTo(2 * 1.25 + 0.5 * 10);
    });

    it("accepts a rate keyed by model alone", () => {
      const total = {
        provider: "openai",
        model: "gpt-5.6-terra",
        inputTokens: 1_000_000,
        outputTokens: 0,
      };
      expect(costOf(total, { "gpt-5.6-terra": { inputPerMillion: 3, outputPerMillion: 9 } })).toBe(3);
    });

    it("drops a rate that would produce a nonsense number", () => {
      expect(
        parseRates({
          good: { inputPerMillion: 1, outputPerMillion: 2 },
          negative: { inputPerMillion: -1, outputPerMillion: 2 },
          nan: { inputPerMillion: "abc", outputPerMillion: 2 },
          missing: { inputPerMillion: 1 },
        }),
      ).toEqual({ good: { inputPerMillion: 1, outputPerMillion: 2 } });
    });
  });

  describe("context windows", () => {
    /*
     * A wrong window is worse than none: it reads as "12% used" when the truth
     * is 60%, and the owner finds out by being truncated. Unknown means
     * undefined, and the caller shows the raw count.
     */
    it("says nothing about a model it does not know", () => {
      expect(contextWindowFor("gpt-5.6-terra")).toBeUndefined();
      expect(contextWindowFor("some-local-llama")).toBeUndefined();
    });

    it("knows the ones it does know, most specific first", () => {
      expect(contextWindowFor("claude-opus-4-8")).toBe(200_000);
      expect(contextWindowFor("claude-sonnet-4-5")).toBe(1_000_000);
    });
  });
});

describe("pricing the cached share", () => {
  const RATES = { "anthropic:opus": { inputPerMillion: 15, outputPerMillion: 75 } };

  it("prefers the cost the provider reported", () => {
    /*
     * The Claude SDK prices every call against the real table for the model
     * that actually ran. It was extracted and then dropped, and the number
     * shown was rebuilt from a flat rate instead.
     */
    const cost = costOf(
      {
        provider: "anthropic",
        model: "opus",
        inputTokens: 207_000,
        outputTokens: 1_000,
        cacheReadTokens: 200_000,
        cacheCreationTokens: 2_000,
        reportedCostUSD: 0.4875,
      },
      RATES,
    );
    expect(cost).toBeCloseTo(0.4875, 6);
  });

  it("prices a cache read at a tenth of fresh input when nothing was reported", () => {
    /*
     * The turn that made this worth fixing: 200k of a 207k context is cache
     * reads. Charged as fresh input that is $3.18; priced properly it is
     * $0.49, so the money column read about six and a half times high.
     */
    const cost = costOf(
      {
        provider: "anthropic",
        model: "opus",
        inputTokens: 207_000,
        outputTokens: 1_000,
        cacheReadTokens: 200_000,
        cacheCreationTokens: 2_000,
      },
      RATES,
    );
    // 5k fresh @15 + 200k @1.50 + 2k @18.75 + 1k out @75
    expect(cost).toBeCloseTo(0.075 + 0.3 + 0.0375 + 0.075, 6);
  });

  it("leaves an uncached total priced exactly as before", () => {
    // Every row written before this existed reports no cached share, so no
    // past figure may move.
    const cost = costOf(
      { provider: "anthropic", model: "opus", inputTokens: 1_000_000, outputTokens: 1_000_000 },
      RATES,
    );
    expect(cost).toBe(90);
  });

  it("takes the owner's own cache rates over the multipliers", () => {
    const cost = costOf(
      {
        provider: "anthropic",
        model: "opus",
        inputTokens: 100_000,
        outputTokens: 0,
        cacheReadTokens: 100_000,
      },
      {
        "anthropic:opus": {
          inputPerMillion: 15,
          outputPerMillion: 75,
          cacheReadPerMillion: 3,
        },
      },
    );
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it("still says nothing when there is no rate and no reported cost", () => {
    expect(
      costOf(
        { provider: "who", model: "what", inputTokens: 10, outputTokens: 10 },
        RATES,
      ),
    ).toBeUndefined();
  });
});

describe("storing the cached share", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-spend-cache-"));
    ws = Workspace.open(root);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the breakdown and the reported cost through a round trip", () => {
    const store = new SpendStore(ws.db, () => 1000);
    store.record({
      conversationId: "c1",
      task: "reasoning",
      provider: "anthropic",
      model: "opus",
      inputTokens: 207_000,
      outputTokens: 1_000,
      cacheReadTokens: 200_000,
      cacheCreationTokens: 2_000,
      costUSD: 0.4875,
    });

    const [total] = store.byModel();
    expect(total).toMatchObject({
      inputTokens: 207_000,
      outputTokens: 1_000,
      cacheReadTokens: 200_000,
      cacheCreationTokens: 2_000,
      reportedCostUSD: 0.4875,
    });
  });

  it("adds the columns to a table that predates them, keeping its rows", () => {
    /*
     * CREATE TABLE IF NOT EXISTS says nothing about a workspace built before
     * these columns existed, and the spend already recorded there is still
     * good.
     */
    ws.db.exec(`
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        conversation_id TEXT,
        task TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL
      );
      INSERT INTO token_usage
        (at, conversation_id, task, provider, model, input_tokens, output_tokens)
      VALUES (5, 'old', 'reasoning', 'anthropic', 'opus', 1000, 500);
    `);

    const store = new SpendStore(ws.db, () => 1000);
    const [total] = store.byModel();
    // The old row survives, and reads as having no cached share -- which is
    // what it had, so its cost does not move.
    expect(total).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reportedCostUSD: 0,
    });
  });
});
