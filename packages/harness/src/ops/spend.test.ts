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
