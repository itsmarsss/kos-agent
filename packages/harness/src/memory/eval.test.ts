import { describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { loadGolden, runMemoryEval, type GoldenCase } from "./eval.js";

const cases: GoldenCase[] = [
  { name: "keeps", events: [{ role: "owner", text: "my sister Nadia is a nurse" }], expect: [{ key: "sister", value: "Nadia" }], forbid: [] },
  { name: "drops", events: [{ role: "owner", text: "what time is it" }], expect: [], forbid: ["time"] },
];

function scripted(answer: (prompt: string) => string): Inference {
  const inference: Inference = {
    generate: async (_task, req) => {
      const prompt = req.messages.map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("")).join("\n");
      return { content: [{ type: "text", text: answer(prompt) }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "fake" };
    },
  };
  return inference;
}

describe("the extractor eval", () => {
  it("scores a perfect reader at full marks and finds the expected claim again", async () => {
    const good = scripted((p) => {
      const id = /\[#(\d+)\]/.exec(p)?.[1];
      return p.includes("Nadia") ? `{"ops":[{"op":"add","key":"sister","value":"Nadia, a nurse","kind":"fact","scope":"global","evidence":[${id}],"confidence":0.9}]}` : '{"ops":[]}';
    });
    const r = await runMemoryEval(good, cases);
    expect(r).toMatchObject({ recall: 1, precision: 1, clean: 2, total: 2 });
    expect(r.cases[0]).toMatchObject({ matched: 1, recalled: 1 });
  });

  it("marks a reader that keeps the wrong thing", async () => {
    const bad = scripted((p) => {
      const id = /\[#(\d+)\]/.exec(p)?.[1];
      return `{"ops":[{"op":"add","key":"current_time","value":"asked what time it is","kind":"fact","scope":"global","evidence":[${id}],"confidence":0.9}]}`;
    });
    const r = await runMemoryEval(bad, cases);
    expect(r.recall).toBe(0);
    expect(r.precision).toBe(0);
    expect(r.clean).toBe(1);
    expect(r.cases[1]!.forbidden).toEqual(["time"]);
  });

  it("ships a golden set that reads", () => {
    const golden = loadGolden();
    expect(golden.length).toBeGreaterThan(8);
    for (const c of golden) expect(c.events.length).toBeGreaterThan(0);
  });
});
