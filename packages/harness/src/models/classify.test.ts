import { describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { HttpClassifier, LlmClassifier, parseClassification } from "./classify.js";

const choice = { kind: "choice" as const, question: "Durable?", text: "my sister is a nurse", labels: ["durable", "passing"] };

describe("classification", () => {
  it("reads a label or a score out of whatever wrapping the endpoint used", () => {
    expect(parseClassification({ label: "Durable", confidence: 0.9 }, choice, "x")).toEqual({ label: "durable", confidence: 0.9, provider: "x" });
    expect(parseClassification({ result: { choice: "passing", probability: 0.4 } }, choice, "x")).toMatchObject({ label: "passing", confidence: 0.4 });
    expect(parseClassification('Sure: {"label":"durable","confidence":0.7}', choice, "x")).toMatchObject({ label: "durable" });
    expect(parseClassification({ label: "maybe", confidence: 1 }, choice, "x")).toBeUndefined();
    expect(parseClassification({ score: 7, confidence: 0.8 }, { kind: "score", question: "q", text: "t", range: [0, 5] }, "x")).toMatchObject({ score: 5, label: "5" });
    expect(parseClassification("nope", choice, "x")).toBeUndefined();
  });

  it("posts the request to the owner's endpoint with the key and takes the answer", async () => {
    const seen: { url: string; auth?: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ label: "durable", confidence: 0.93 }), { status: 200 });
    }) as typeof fetch;
    const c = new HttpClassifier({ url: "https://jev.example/classify", apiKey: "k", fetchImpl });
    expect(await c.classify(choice)).toEqual({ label: "durable", confidence: 0.93, provider: "classifier" });
    expect(seen[0]).toMatchObject({ url: "https://jev.example/classify", auth: "Bearer k" });
    expect((seen[0]!.body as { labels: string[] }).labels).toEqual(["durable", "passing"]);
  });

  it("falls back to the cheap route, and to no confidence when it cannot read the answer", async () => {
    const answers = ['{"label":"durable","confidence":0.8}', "I would say durable."];
    const inference: Inference = {
      generate: async () => ({ content: [{ type: "text", text: answers.shift()! }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "fake" }),
    };
    const c = new LlmClassifier(inference);
    expect(await c.classify(choice)).toMatchObject({ label: "durable", confidence: 0.8, provider: "llm" });
    expect(await c.classify(choice)).toMatchObject({ confidence: 0 });
  });
});
