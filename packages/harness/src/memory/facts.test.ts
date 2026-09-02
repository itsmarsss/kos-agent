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

  it("upserts by (user, key), updating value and timestamp", () => {
    facts.upsert("u1", { key: "timezone", value: "UTC", kind: "fact" });
    clock = 2000;
    facts.upsert("u1", { key: "timezone", value: "PST", kind: "fact" });
    const f = facts.get("u1", "timezone");
    expect(f?.value).toBe("PST");
    expect(f?.createdAt).toBe(1000);
    expect(f?.updatedAt).toBe(2000);
    expect(facts.all("u1")).toHaveLength(1);
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

  it("deletes a fact", () => {
    facts.upsert("u1", { key: "k", value: "v", kind: "fact" });
    expect(facts.delete("u1", "k")).toBe(true);
    expect(facts.get("u1", "k")).toBeUndefined();
    expect(facts.delete("u1", "k")).toBe(false);
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
