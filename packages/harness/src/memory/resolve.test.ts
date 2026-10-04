import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { FactsStore } from "./facts.js";
import { applyResolution, splitQualified } from "./resolve.js";
import { ReviewQueue } from "./review.js";

describe("carrying out a review decision", () => {
  let root: string;
  let ws: Workspace;
  let facts: FactsStore;
  let queue: ReviewQueue;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-resolve-"));
    ws = Workspace.open(root);
    facts = new FactsStore(ws.db);
    queue = new ReviewQueue(ws.db);
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("splits a qualified key", () => {
    expect(splitQualified("project:pantry/city")).toEqual({ scope: "project:pantry", key: "city" });
    expect(splitQualified("global/coffee_order")).toEqual({ scope: "global", key: "coffee_order" });
    expect(splitQualified("nope")).toBeUndefined();
  });

  it("keeping one side of a contradiction archives the other, as the owner's doing", () => {
    facts.upsert("owner", { key: "city", value: "Montreal", kind: "fact" });
    facts.upsert("owner", { key: "city", value: "Lisbon", kind: "fact", scope: "project:trip" });
    const item = queue.add("contradiction", ["global/city", "project:trip/city"], "which?");
    const r = applyResolution(facts, queue, "owner", item.id, { action: "keep", key: "global/city" })!;
    expect(r.archived).toEqual(["project:trip/city"]);
    expect(facts.get("owner", "city", "project:trip")).toBeUndefined();
    expect(facts.get("owner", "city")?.value).toBe("Montreal");
    expect(r.item.resolution).toBe("keep global/city");
    expect(queue.pending()).toEqual([]);
    expect(() => applyResolution(facts, queue, "owner", queue.add("contradiction", ["global/a", "global/b"], "x").id, { action: "keep", key: "global/zzz" })).toThrow(/keep needs one of/);
  });

  it("promoting writes the claim global and closes the project one, evidence and all", () => {
    facts.upsert("owner", { key: "editor", value: "neovim", kind: "preference", scope: "project:site", tags: ["tools"], evidence: [9] });
    const item = queue.add("promotion", ["project:site/editor"], "true everywhere");
    const r = applyResolution(facts, queue, "owner", item.id, { action: "promote" })!;
    expect(r.promoted).toEqual(["project:site/editor"]);
    const global = facts.get("owner", "editor", "global")!;
    expect(global).toMatchObject({ value: "neovim", tags: ["tools"], source: "owner" });
    expect(facts.trace(global.id)!.evidence).toEqual([9]);
    expect(facts.get("owner", "editor", "project:site")).toBeUndefined();
  });

  it("will not promote the outside world's word", () => {
    facts.upsert("owner", { key: "target", value: "staff roles", kind: "fact", scope: "project:resume", trust: "external" });
    const item = queue.add("promotion", ["project:resume/target"], "seen twice");
    const r = applyResolution(facts, queue, "owner", item.id, { action: "promote" })!;
    expect(r.promoted).toEqual([]);
    expect(facts.get("owner", "target", "global")).toBeUndefined();
    expect(facts.get("owner", "target", "project:resume")).toBeDefined();
  });

  it("both and dismiss change nothing but the record, and a settled item stays settled", () => {
    facts.upsert("owner", { key: "a", value: "1", kind: "fact" });
    const item = queue.add("other", ["global/a"], "hm");
    expect(applyResolution(facts, queue, "owner", item.id, { action: "both" })!.item.resolution).toBe("both");
    expect(facts.get("owner", "a")?.value).toBe("1");
    expect(applyResolution(facts, queue, "owner", item.id, { action: "dismiss" })).toBeUndefined();
  });
});
