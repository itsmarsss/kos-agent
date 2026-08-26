import { describe, expect, it } from "vitest";

import {
  CohereEmbeddingProvider,
  HashingEmbeddingProvider,
  isSemantic,
} from "./embeddings.js";

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

describe("CohereEmbeddingProvider", () => {
  function stubFetch(body: unknown, ok = true) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok,
        status: ok ? 200 : 401,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  function provider(fetchImpl: typeof fetch) {
    return new CohereEmbeddingProvider({
      apiKey: "k",
      model: "embed-english-v3.0",
      dimension: 256,
      fetchImpl,
    });
  }

  it("parses float embeddings from the v2 response", async () => {
    const { impl } = stubFetch({ embeddings: { float: [[1, 2, 3]] } });
    expect(await provider(impl).embed(["hello"])).toEqual([[1, 2, 3]]);
  });

  it("marks stored text and search text with different input types", async () => {
    const { impl, calls } = stubFetch({ embeddings: { float: [[1]] } });
    const p = provider(impl);
    await p.embed(["a"], "document");
    await p.embed(["a"], "query");
    const types = calls.map(
      (c) => JSON.parse(String(c.init.body)).input_type as string,
    );
    // Cohere embeds the two asymmetrically; collapsing them costs accuracy.
    expect(types).toEqual(["search_document", "search_query"]);
  });

  it("defaults to document mode", async () => {
    const { impl, calls } = stubFetch({ embeddings: { float: [[1]] } });
    await provider(impl).embed(["a"]);
    expect(JSON.parse(String(calls[0]!.init.body)).input_type).toBe(
      "search_document",
    );
  });

  it("skips the request entirely for an empty batch", async () => {
    const { impl, calls } = stubFetch({});
    expect(await provider(impl).embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("throws with the response body on failure", async () => {
    const { impl } = stubFetch({ message: "bad key" }, false);
    await expect(provider(impl).embed(["a"])).rejects.toThrow(/401/);
  });

  it("throws when the response carries no float embeddings", async () => {
    const { impl } = stubFetch({ embeddings: {} });
    await expect(provider(impl).embed(["a"])).rejects.toThrow(/no float/);
  });
});

describe("isSemantic", () => {
  it("does not count the hashing fallback as semantic", () => {
    expect(isSemantic(new HashingEmbeddingProvider(128))).toBe(false);
  });
});
