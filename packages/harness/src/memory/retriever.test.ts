import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { HashingEmbeddingProvider } from "./embeddings.js";
import { EventLog } from "./events.js";
import { assembleSystemPrompt } from "../kernel/context.js";
import { DEFAULT_PROFILE } from "../kernel/profile.js";
import { FactsStore, type Fact } from "./facts.js";
import { MemoryRetriever, STANDING_LIMIT, withStanding } from "./retriever.js";

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

describe("what a turn remembers", () => {
  const fact = (key: string, over: Partial<Fact> = {}): Fact => ({
    id: key.length,
    userId: "u1",
    key,
    value: `${key} value`,
    kind: "fact",
    scope: "global",
    source: null,
    tags: [],
    pinned: false,
    trust: "owner",
    confidence: 1,
    createdAt: 0,
    updatedAt: 0,
    supersededAt: null,
    supersedes: null,
    lastUsedAt: null,
    useCount: 0,
    ...over,
  });

  it("keeps room for what the words matched, however much stands", () => {
    const pinned = ["p1", "p2", "p3", "p4"].map((k) => fact(k, { pinned: true }));
    const prefs = ["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => fact(`pref_${k}`, { kind: "preference" }));
    const matched = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"].map((k) => fact(k));
    const kept = withStanding([...pinned, ...prefs].slice(0, STANDING_LIMIT), matched);
    expect(kept.filter((f) => f.key.startsWith("m"))).toHaveLength(9);
    expect(kept.slice(0, 4).map((f) => f.key)).toEqual(["p1", "p2", "p3", "p4"]);
    // The prompt shows every one of them, matched claims included.
    const { turnContext } = assembleSystemPrompt({ baseSystem: "You are KOS.", profile: DEFAULT_PROFILE, projects: [], recall: { facts: kept, events: [] } });
    for (const m of matched) expect(turnContext).toContain(`${m.key}: ${m.value}`);
    // A matched claim that also stands is said once.
    expect(withStanding([fact("p1", { pinned: true })], [fact("p1"), fact("m1")]).map((f) => f.key)).toEqual(["p1", "m1"]);
  });
});
