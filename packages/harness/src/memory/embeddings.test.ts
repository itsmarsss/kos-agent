import { describe, expect, it } from "vitest";

import { HashingEmbeddingProvider } from "./embeddings.js";

function dot(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
}

describe("HashingEmbeddingProvider", () => {
  const provider = new HashingEmbeddingProvider(128);

  it("produces vectors of the configured dimension", async () => {
    const [v] = await provider.embed(["hello world"]);
    expect(v).toHaveLength(128);
  });

  it("is deterministic", async () => {
    const [a] = await provider.embed(["repeatable text"]);
    const [b] = await provider.embed(["repeatable text"]);
    expect(a).toEqual(b);
  });

  it("scores overlapping text more similar than unrelated text", async () => {
    const [base, related, unrelated] = await provider.embed([
      "hiking in the forest with a tent",
      "hiking and camping with a tent",
      "quarterly tax accounting spreadsheet",
    ]);
    expect(dot(base!, related!)).toBeGreaterThan(dot(base!, unrelated!));
  });
});
