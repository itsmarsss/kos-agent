import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { HashingEmbeddingProvider } from "./embeddings.js";
import { EventLog, ftsQuery } from "./events.js";

describe("the events log", () => {
  const embedder = new HashingEmbeddingProvider(64);
  let root: string;
  let ws: Workspace;
  let log: EventLog;
  let clock: number;

  const embed = async (text: string): Promise<number[]> => (await embedder.embed([text]))[0]!;
  const say = async (text: string, over: Partial<Parameters<EventLog["append"]>[0]> = {}): Promise<number> =>
    log.append({ userId: "owner", role: "owner", text, ...over }, await embed(text));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-events-"));
    ws = Workspace.open(root);
    clock = 1_000;
    log = new EventLog(ws.db, embedder.dimension, () => clock++, embedder.name);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("turns free text into a match the engine accepts", () => {
    expect(ftsQuery('what did we say about the "garden" shed?')).toBe('"what" OR "did" OR "we" OR "say" OR "about" OR "the" OR "garden" OR "shed"');
    expect(ftsQuery("a ? !")).toBeNull();
  });

  it("keeps who said what, where, and finds it by words alone", async () => {
    await say("the garden shed needs a new roof before winter", { conversationId: "c1", projectSlug: "house" });
    await say("let us plan the trip to Lisbon in May", { conversationId: "c2" });
    const hits = log.search({ userId: "owner", query: "shed roof" });
    expect(hits.map((h) => h.text)).toEqual(["the garden shed needs a new roof before winter"]);
    expect(hits[0]).toMatchObject({ conversationId: "c1", projectSlug: "house", role: "owner", trust: "owner", caller: "kos", shadowed: false });
  });

  it("finds by meaning when the words differ, and ranks a hit on both higher", async () => {
    await say("I bike to work most days");
    await say("quarterly tax accounting is due");
    await say("cycling to the office keeps me fit");
    const q = "bike to work";
    const byVector = log.search({ userId: "owner", embedding: await embed(q) });
    expect(byVector.length).toBeGreaterThan(0);
    const both = log.search({ userId: "owner", query: q, embedding: await embed(q), k: 2 });
    // The exact sentence is on both lists; the paraphrase at best on one;
    // the tax line is nearest-neighbour noise and loses to both.
    expect(both[0]!.text).toBe("I bike to work most days");
    expect(both.map((h) => h.text)).not.toContain("quarterly tax accounting is due");
  });

  it("nudges the active project's events up without hiding the rest", async () => {
    await say("the budget spreadsheet lives in the shared drive", { projectSlug: "budget" });
    await say("the budget for the shed is 400 dollars", { projectSlug: "house" });
    const q = "budget";
    const inHouse = log.search({ userId: "owner", query: q, projectSlug: "house", k: 2 });
    expect(inHouse[0]!.projectSlug).toBe("house");
    expect(inHouse).toHaveLength(2);
    const inBudget = log.search({ userId: "owner", query: q, projectSlug: "budget", k: 2 });
    expect(inBudget[0]!.projectSlug).toBe("budget");
  });

  it("shadows without forgetting, and keeps another user's events out", async () => {
    const id = await say("remember the wifi password is on the fridge", { conversationId: "c1" });
    log.append({ userId: "other", role: "owner", text: "the wifi is slow" });
    log.shadow([id]);
    expect(log.get(id)?.shadowed).toBe(true);
    expect(log.search({ userId: "owner", query: "wifi" }).map((h) => h.id)).toEqual([id]);
    expect(log.recent("c1").map((e) => e.id)).toEqual([id]);
    expect(log.count("owner")).toBe(1);
  });

  it("scopes a search to one conversation when asked", async () => {
    await say("deploy target is staging", { conversationId: "c1" });
    await say("deploy target is production", { conversationId: "c2" });
    const q = "deploy target";
    const hits = log.search({ userId: "owner", query: q, embedding: await embed(q), conversationId: "c2" });
    expect(hits.map((h) => h.text)).toEqual(["deploy target is production"]);
  });

  it("brings an older workspace's episodes in as its first events, once", async () => {
    // A workspace from before the log: exchanges in memory_events with vectors.
    ws.close();
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "kos-events-old-"));
    ws = Workspace.open(root);
    sqliteVec.load(ws.db);
    ws.db.exec(`CREATE TABLE memory_events (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, provider TEXT);
      CREATE VIRTUAL TABLE memory_vec_${embedder.dimension} USING vec0(embedding float[${embedder.dimension}])`);
    ws.db.prepare(`INSERT INTO memory_events (id, user_id, text, created_at, provider) VALUES (1, 'owner', ?, 5, ?)`)
      .run("user: my dentist is Dr Lee\nassistant: noted", embedder.name);
    ws.db.prepare(`INSERT INTO memory_vec_${embedder.dimension} (rowid, embedding) VALUES (?, ?)`)
      .run(1n, Buffer.from(new Float32Array(await embed("my dentist is Dr Lee")).buffer));
    const fresh = new EventLog(ws.db, embedder.dimension, () => clock++, embedder.name);
    expect(fresh.count("owner")).toBe(1);
    const hits = fresh.search({ userId: "owner", embedding: await embed("who is my dentist"), query: "dentist" });
    expect(hits[0]).toMatchObject({ kind: "exchange", role: "owner", ts: 5 });
    // Opening again does not copy twice.
    expect(new EventLog(ws.db, embedder.dimension, () => clock++, embedder.name).count("owner")).toBe(1);
  });

  it("redacts what the owner forgot: words gone from text, index and vectors, row kept", async () => {
    const id = await say("my passport number is 123456", { conversationId: "c1" });
    log.redact([id]);
    expect(log.get(id)).toMatchObject({ text: "[forgotten]", conversationId: "c1" });
    expect(log.search({ userId: "owner", query: "passport" })).toEqual([]);
    expect(log.search({ userId: "owner", embedding: await embed("passport number") })).toEqual([]);
  });

  it("hands a reader the owner's, KOS's and a caller's words, never a tool's", async () => {
    const a = log.append({ userId: "owner", role: "owner", text: "mine" });
    const b = log.append({ userId: "owner", role: "owner", text: "theirs", trust: "external", caller: "app" });
    log.append({ userId: "owner", role: "tool", text: "tool output" });
    expect(log.since("owner", 0).map((e) => [e.id, e.trust])).toEqual([[a, "owner"], [b, "external"]]);
  });

  it("refuses a vector of the wrong size", () => {
    expect(() => log.append({ userId: "owner", role: "owner", text: "x" }, [1, 2, 3])).toThrow(/dimension/);
  });
});
