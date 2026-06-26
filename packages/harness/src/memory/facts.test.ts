import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { FactsStore } from "./facts.js";

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
