import { describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import type { ContentBlock } from "../models/types.js";
import { loadDreamGolden, loadObserveGolden, runDreamEval, runObserveEval, type DreamCase, type ObserveCase } from "./evaljobs.js";

/** A model that calls the tools it is told to, in order, then speaks. */
function scripted(steps: ((prompt: string) => ContentBlock[] | string)[]): Inference {
  let i = 0;
  const inference: Inference = {
    generate: async (_task, req) => {
      const prompt = req.messages.map((m) => m.content.map((c) => (c.type === "text" ? c.text : c.type === "tool_result" ? String(c.content) : "")).join("\n")).join("\n");
      const step = steps[Math.min(i, steps.length - 1)]!;
      i++;
      const out = step(prompt);
      const content: ContentBlock[] = typeof out === "string" ? [{ type: "text", text: out }] : out;
      return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "fake" };
    },
  };
  return inference;
}
const call = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: "tool_use", id, name, input }];

describe("the dream and observe evals", () => {
  it("scores a dream that merges the pair and flags the contradiction", async () => {
    const cases: DreamCase[] = [
      { name: "merge", seed: [{ key: "global/favourite_tea", value: "oolong", kind: "preference" }, { key: "global/favorite_tea", value: "oolong tea", kind: "preference" }], expect: { merged: [["global/favourite_tea", "global/favorite_tea"]], kept: [] } },
    ];
    const model = scripted([
      () => call("t1", "memory.review", {}),
      () => call("t2", "memory.merge", { keep: "favourite_tea", drop: "favorite_tea" }),
      () => "Merged 1, archived 0, flagged 0, wrote 0.",
    ]);
    const r = await runDreamEval(model, cases);
    expect(r).toMatchObject({ job: "dream", score: 1, clean: 1, total: 1 });
    expect(r.cases[0]!.met).toEqual(["merged global/favourite_tea and global/favorite_tea into one"]);
  }, 30_000);

  it("counts a lost claim as harm and a missing flag as a miss", async () => {
    const cases: DreamCase[] = [
      { name: "contradiction", seed: [{ key: "global/city", value: "Montreal", kind: "fact" }, { key: "project:trip/city", value: "Lisbon", kind: "fact" }], expect: { flagged: ["contradiction"], kept: ["global/city", "project:trip/city"] } },
    ];
    const reckless = scripted([
      () => call("t1", "memory.review", {}),
      () => call("t2", "memory.archive", { key: "city", scope: "project:trip", reason: "guess" }),
      () => "Archived 1.",
    ]);
    const r = await runDreamEval(reckless, cases);
    expect(r.cases[0]!.missed).toEqual(["flagged contradiction"]);
    expect(r.cases[0]!.harm).toEqual(["lost project:trip/city"]);
    expect(r.clean).toBe(0);
  }, 30_000);

  it("scores an observation by what the note keeps and what it must not say", async () => {
    const cases: ObserveCase[] = [
      { name: "plan", turns: [["owner", "we picked SQLite for the pantry app"], ["kos", "noted"], ["owner", "barcode first"], ["kos", "ok"], ["owner", "no photos"], ["kos", "ok"], ["owner", "x"], ["kos", "y"], ["owner", "z"], ["kos", "w"], ["owner", "later"], ["kos", "sure"]], mustMention: ["SQLite", "barcode"], mustNotMention: ["later"] },
    ];
    const model = scripted([
      () => call("t1", "memory.threads", {}),
      (p) => call("t2", "memory.thread", { id: /"id":"([^"]+)"/.exec(p)?.[1] ?? "" }),
      (p) => call("t3", "memory.observe", { id: /"id":"([^"]+)"/.exec(p)?.[1] ?? "", note: "Chose SQLite; barcode scanning first; no photos." }),
      () => "Observed one thread.",
    ]);
    const r = await runObserveEval(model, cases);
    expect(r).toMatchObject({ job: "observe", score: 1, clean: 1, total: 1 });
  }, 30_000);

  it("ships golden sets that read", () => {
    expect(loadDreamGolden().length).toBeGreaterThan(4);
    expect(loadObserveGolden().length).toBeGreaterThan(2);
  });
});
