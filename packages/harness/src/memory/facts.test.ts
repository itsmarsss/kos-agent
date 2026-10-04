import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { FactsStore, stem } from "./facts.js";

describe("FactsStore", () => {
  let root: string;
  let ws: Workspace;
  let facts: FactsStore;
  let clock: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-facts-"));
    ws = Workspace.open(root);
    clock = 1000;
    facts = new FactsStore(ws.db, () => clock);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("inserts and reads a fact", () => {
    facts.upsert("u1", { key: "timezone", value: "UTC", kind: "fact" });
    expect(facts.get("u1", "timezone")).toMatchObject({
      key: "timezone",
      value: "UTC",
      kind: "fact",
    });
  });

  it("replaces a value by supersession: the current claim is new, the old one kept", () => {
    facts.upsert("u1", { key: "timezone", value: "UTC", kind: "fact" });
    clock = 2000;
    facts.upsert("u1", { key: "timezone", value: "PST", kind: "fact" });
    const now = facts.get("u1", "timezone")!;
    expect(now).toMatchObject({ value: "PST", createdAt: 2000, updatedAt: 2000 });
    expect(facts.history("u1", "timezone").map((f) => [f.value, f.createdAt, f.supersededAt])).toEqual([["UTC", 1000, 2000], ["PST", 2000, null]]);
  });

  it("scopes facts per user", () => {
    facts.upsert("u1", { key: "k", value: "a", kind: "fact" });
    facts.upsert("u2", { key: "k", value: "b", kind: "fact" });
    expect(facts.get("u1", "k")?.value).toBe("a");
    expect(facts.get("u2", "k")?.value).toBe("b");
  });

  it("searches keys and values", () => {
    facts.upsert("u1", { key: "timezone", value: "UTC", kind: "fact" });
    facts.upsert("u1", { key: "city", value: "Tokyo", kind: "fact" });
    expect(facts.search("u1", "zone").map((f) => f.key)).toEqual(["timezone"]);
    expect(facts.search("u1", "Tokyo").map((f) => f.key)).toEqual(["city"]);
  });

  it("deletes a fact, every version of it, and says which events it was drawn from", () => {
    facts.upsert("u1", { key: "k", value: "v", kind: "fact", evidence: [7] });
    facts.upsert("u1", { key: "k", value: "w", kind: "fact", evidence: [9] });
    expect(facts.delete("u1", "k")).toEqual({ removed: true, evidence: [7, 9] });
    expect(facts.get("u1", "k")).toBeUndefined();
    expect(facts.history("u1", "k")).toEqual([]);
    expect(facts.delete("u1", "k")).toEqual({ removed: false, evidence: [] });
  });

  it("supersedes rather than overwrites, and keeps the pin and tags across", () => {
    facts.upsert("u1", { key: "city", value: "Toronto", kind: "fact", tags: ["home"], pinned: true, evidence: [1] }, "c1");
    clock = 2000;
    const moved = facts.upsert("u1", { key: "city", value: "Lisbon", kind: "fact", evidence: [2] }, "c2");
    expect(moved).toMatchObject({ value: "Lisbon", pinned: true, tags: ["home"], supersededAt: null, source: "c2" });
    const history = facts.history("u1", "city");
    expect(history.map((f) => [f.value, f.supersededAt])).toEqual([["Toronto", 2000], ["Lisbon", null]]);
    expect(moved.supersedes).toBe(history[0]!.id);
    expect(facts.all("u1").map((f) => f.value)).toEqual(["Lisbon"]);
    const trace = facts.trace(moved.id)!;
    expect(trace.evidence).toEqual([2]);
    expect(trace.before.map((b) => b.value)).toEqual(["Toronto"]);
    expect(trace.revisions.map((r) => r.action)).toEqual(["supersede"]);
    expect(facts.trace(history[0]!.id)!.revisions.map((r) => r.action)).toEqual(["add"]);
  });

  it("treats a restatement as the same claim: touched, more evidence, no new row", () => {
    facts.upsert("u1", { key: "tz", value: "UTC", kind: "fact", evidence: [1] });
    clock = 1500;
    const again = facts.upsert("u1", { key: "tz", value: "UTC", kind: "fact", evidence: [3] });
    expect(again.updatedAt).toBe(1500);
    expect(facts.history("u1", "tz")).toHaveLength(1);
    expect(facts.trace(again.id)!.evidence).toEqual([1, 3]);
  });

  it("keeps a project's claim beside the global one, and reads by scope", () => {
    facts.upsert("u1", { key: "deploy_target", value: "staging", kind: "fact", scope: "project:site" });
    facts.upsert("u1", { key: "deploy_target", value: "nowhere yet", kind: "fact" });
    expect(facts.get("u1", "deploy_target")?.value).toBe("nowhere yet");
    expect(facts.get("u1", "deploy_target", "project:site")?.value).toBe("staging");
    expect(facts.search("u1", "deploy target", 10, { scopes: ["global", "project:site"] }).map((f) => f.scope).sort()).toEqual(["global", "project:site"]);
    expect(facts.search("u1", "deploy target", 10, { scopes: ["global", "project:other"] }).map((f) => f.scope)).toEqual(["global"]);
    expect(facts.pinned("u1", ["project:site"])).toEqual([]);
  });

  it("holds a weak match back when a floor is set", () => {
    facts.upsert("u1", { key: "coffee_order", value: "flat white with oat milk", kind: "preference" });
    // "milk" alone hits the value once: score 1.
    expect(facts.search("u1", "milk", 10)).toHaveLength(1);
    expect(facts.search("u1", "milk", 10, { minScore: 2 })).toHaveLength(0);
    expect(facts.search("u1", "coffee order", 10, { minScore: 2 })).toHaveLength(1);
  });

  it("counts use, for decay later", () => {
    const f = facts.upsert("u1", { key: "k", value: "v", kind: "fact" });
    clock = 3000;
    facts.markUsed([f.id]);
    expect(facts.get("u1", "k")).toMatchObject({ useCount: 1, lastUsedAt: 3000 });
  });

  it("brings an older workspace's facts in as claims, once", () => {
    ws.db.exec(`CREATE TABLE memory_facts (id INTEGER PRIMARY KEY, user_id TEXT, key TEXT, value TEXT, kind TEXT, source TEXT, tags TEXT, pinned INTEGER, created_at INTEGER, updated_at INTEGER)`);
    ws.db.prepare(`INSERT INTO memory_facts VALUES (1, 'u9', 'name', 'Ada', 'fact', 'chat', '["me"]', 1, 10, 20)`).run();
    ws.db.exec(`DELETE FROM memory_claims`);
    const fresh = new FactsStore(ws.db, () => clock);
    expect(fresh.get("u9", "name")).toMatchObject({ value: "Ada", scope: "global", tags: ["me"], pinned: true, createdAt: 10 });
    expect(new FactsStore(ws.db, () => clock).all("u9")).toHaveLength(1);
  });
});

describe("FactsStore.search keyword recall", () => {
  let root: string;
  let ws: Workspace;
  let facts: FactsStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-facts-kw-"));
    ws = Workspace.open(root);
    facts = new FactsStore(ws.db);
    facts.upsert("u1", { key: "timezone", value: "America/New_York", kind: "fact" });
    facts.upsert("u1", { key: "employer", value: "Acme Robotics", kind: "fact" });
    facts.upsert("u1", { key: "coffee_order", value: "oat flat white", kind: "preference" });
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("matches a fact from a full sentence, not just an exact substring", () => {
    // The regression: the whole message used to be one LIKE pattern, so this
    // matched nothing and the structured tier was always empty.
    const hits = facts.search("u1", "wait what timezone am I in again?");
    expect(hits.map((f) => f.key)).toContain("timezone");
  });

  it("ranks a key hit above a value-only hit", () => {
    facts.upsert("u1", { key: "commute", value: "timezone aware scheduling", kind: "fact" });
    const hits = facts.search("u1", "tell me about my timezone");
    expect(hits[0]?.key).toBe("timezone");
  });

  it("ignores stopword-only queries rather than matching everything", () => {
    const hits = facts.search("u1", "what did you say that was");
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it("returns nothing when no token matches", () => {
    expect(facts.search("u1", "quantum chromodynamics")).toEqual([]);
  });

  it("finds a singular entry from a plural word", () => {
    facts.upsert("u1", {
      key: "standing_meeting",
      value: "Tuesdays at 10",
      kind: "fact",
    });
    // Asking about "meetings" when the entry says "meeting" is the ordinary
    // way to ask, and used to match nothing at all.
    expect(facts.search("u1", "what are my meetings")[0]?.key).toBe(
      "standing_meeting",
    );
    expect(facts.search("u1", "recurring expenses")).toEqual([]);
  });

  it("does not cut a short word down to a fragment", () => {
    facts.upsert("u1", { key: "gas_provider", value: "Con Edison", kind: "fact" });
    // "gas" must not stem to "ga", which would match almost anything.
    expect(stem("gas")).toBe("gas");
    expect(stem("class")).toBe("class");
    expect(stem("expenses")).toBe("expense");
    expect(stem("categories")).toBe("category");
  });

  it("scopes results to the requesting user", () => {
    facts.upsert("u2", { key: "timezone", value: "Europe/Berlin", kind: "fact" });
    const hits = facts.search("u1", "timezone");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe("America/New_York");
  });
});
