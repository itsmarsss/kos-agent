import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { HashingEmbeddingProvider } from "./embeddings.js";
import { EpisodicStore } from "./episodic.js";
import { FactsStore } from "./facts.js";
import { MemoryRetriever } from "./retriever.js";

describe("MemoryRetriever", () => {
  let root: string;
  let ws: Workspace;
  let facts: FactsStore;
  let episodic: EpisodicStore;
  const embedder = new HashingEmbeddingProvider(128);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-recall-"));
    ws = Workspace.open(root);
    facts = new FactsStore(ws.db);
    episodic = new EpisodicStore(ws.db, embedder.dimension);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns structured facts and skips the vector store when facts match", async () => {
    facts.upsert("u1", { key: "timezone", value: "UTC", kind: "fact" });
    const [v] = await embedder.embed(["timezone note"]);
    episodic.add("u1", "timezone note episode", v!);

    const retriever = new MemoryRetriever(facts, episodic, embedder);
    const recall = await retriever.recall("u1", "timezone");
    expect(recall.facts).toHaveLength(1);
    expect(recall.episodes).toHaveLength(0); // structured-first, no fallback
  });

  it("falls back to the vector store when no facts match", async () => {
    const [v] = await embedder.embed(["went hiking in the hills today"]);
    episodic.add("u1", "went hiking in the hills today", v!);

    const retriever = new MemoryRetriever(facts, episodic, embedder);
    const recall = await retriever.recall("u1", "hiking trip");
    expect(recall.facts).toHaveLength(0);
    expect(recall.episodes.length).toBeGreaterThan(0);
  });

  it("works with no vector layer configured", async () => {
    facts.upsert("u1", { key: "city", value: "Tokyo", kind: "fact" });
    const retriever = new MemoryRetriever(facts);
    const recall = await retriever.recall("u1", "Tokyo");
    expect(recall.facts).toHaveLength(1);
    expect(recall.episodes).toEqual([]);
  });
});
