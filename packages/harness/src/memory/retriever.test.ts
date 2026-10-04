import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { HashingEmbeddingProvider } from "./embeddings.js";
import { EventLog } from "./events.js";
import { FactsStore } from "./facts.js";
import { MemoryRetriever } from "./retriever.js";

describe("MemoryRetriever", () => {
  const embedder = new HashingEmbeddingProvider(128);
  let root: string;
  let ws: Workspace;
  let facts: FactsStore;
  let events: EventLog;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-retr-"));
    ws = Workspace.open(root);
    facts = new FactsStore(ws.db);
    events = new EventLog(ws.db, embedder.dimension, Date.now, embedder.name);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("brings back matching facts and matching moments together", async () => {
    facts.upsert("owner", { key: "coffee_order", value: "flat white", kind: "preference" });
    const [e] = await embedder.embed(["we talked about switching the coffee order to oat milk"]);
    events.append({ userId: "owner", role: "owner", text: "we talked about switching the coffee order to oat milk", projectSlug: "cafe" }, e!);
    const r = await new MemoryRetriever(facts, events, embedder).recall("owner", "coffee order", { projectSlug: "cafe" });
    expect(r.facts.map((f) => f.key)).toEqual(["coffee_order"]);
    expect(r.events.map((x) => x.projectSlug)).toEqual(["cafe"]);
  });

  it("still searches the log when a fact matched", async () => {
    facts.upsert("owner", { key: "deploy_target", value: "staging", kind: "fact" });
    events.append({ userId: "owner", role: "agent", text: "deploy target was moved to production last week" });
    const r = await new MemoryRetriever(facts, events).recall("owner", "deploy target");
    expect(r.facts).toHaveLength(1);
    expect(r.events).toHaveLength(1);
  });

  it("works with facts alone, and asks nothing for an empty query", async () => {
    facts.upsert("owner", { key: "name", value: "Ada", kind: "fact" });
    expect((await new MemoryRetriever(facts).recall("owner", "name")).events).toEqual([]);
    expect((await new MemoryRetriever(facts, events, embedder).recall("owner", "   ")).events).toEqual([]);
  });
});
