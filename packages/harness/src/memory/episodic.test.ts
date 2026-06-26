import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { HashingEmbeddingProvider } from "./embeddings.js";
import { EpisodicStore } from "./episodic.js";

describe("EpisodicStore", () => {
  let root: string;
  let ws: Workspace;
  let store: EpisodicStore;
  const embedder = new HashingEmbeddingProvider(128);

  async function add(userId: string, text: string): Promise<void> {
    const [v] = await embedder.embed([text]);
    store.add(userId, text, v!);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-epi-"));
    ws = Workspace.open(root);
    store = new EpisodicStore(ws.db, embedder.dimension);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the semantically nearest episode first", async () => {
    await add("u1", "hiking and camping in the mountains");
    await add("u1", "my favorite food is sushi and ramen");
    const [q] = await embedder.embed(["camping and hiking trip"]);

    const hits = store.search("u1", q!, 2);
    expect(hits[0]?.text).toContain("hiking");
  });

  it("scopes results to the user", async () => {
    await add("u1", "hiking and camping trip");
    await add("u2", "hiking and camping trip");
    const [q] = await embedder.embed(["hiking camping"]);
    const hits = store.search("u1", q!, 5);
    expect(hits.every((h) => h.userId === "u1")).toBe(true);
  });

  it("rejects an embedding of the wrong dimension", () => {
    expect(() => store.add("u1", "x", [1, 2, 3])).toThrow(/dimension/);
  });
});
