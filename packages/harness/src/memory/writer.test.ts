import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Workspace } from "../store/workspace.js";
import { FactsStore } from "./facts.js";
import { MemoryWriter, type SalienceConfirmer } from "./writer.js";
import type { CandidateFact } from "./salience.js";

describe("MemoryWriter", () => {
  let root: string;
  let ws: Workspace;
  let facts: FactsStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-mw-"));
    ws = Workspace.open(root);
    facts = new FactsStore(ws.db);
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes durable facts immediately", async () => {
    const writer = new MemoryWriter(facts);
    const written = await writer.ingest("u1", "My timezone is UTC");
    expect(written).toHaveLength(1);
    expect(facts.get("u1", "timezone")?.value).toBe("UTC");
  });

  it("points a fact at the event it was drawn from", async () => {
    await new MemoryWriter(facts).ingest("u1", "My timezone is UTC", "chat", { evidence: [42] });
    const f = facts.get("u1", "timezone")!;
    expect(facts.trace(f.id)!.evidence).toEqual([42]);
  });

  it("skips non-salient text", async () => {
    const writer = new MemoryWriter(facts);
    expect(await writer.ingest("u1", "nice weather")).toEqual([]);
    expect(facts.all("u1")).toEqual([]);
  });

  it("routes maybe-salient text through the confirmer", async () => {
    const confirmer: SalienceConfirmer = {
      async confirm(): Promise<CandidateFact[]> {
        return [{ key: "ritual", value: "coffee at 9am", kind: "fact" }];
      },
    };
    const writer = new MemoryWriter(facts, confirmer);
    const written = await writer.ingest("u1", "I always drink coffee at 9am");
    expect(written).toHaveLength(1);
    expect(facts.get("u1", "ritual")?.value).toBe("coffee at 9am");
  });

  it("asks the gate before the confirmer, and skips the confirm when the gate says passing", async () => {
    let confirms = 0;
    const confirmer = { confirm: async (_t: string, c: CandidateFact[]) => { confirms++; return c.length ? c : [{ key: "coffee", value: "9am", kind: "fact" as const }]; } };
    const closed = new MemoryWriter(facts, confirmer, async () => false);
    expect(await closed.ingest("u1", "I always drink coffee at 9am")).toEqual([]);
    expect(confirms).toBe(0);
    const open = new MemoryWriter(facts, confirmer, async () => true);
    expect((await open.ingest("u1", "I always drink coffee at 9am")).length).toBeGreaterThan(0);
    expect(confirms).toBe(1);
    // A gate that fails is not a reason to lose a fact.
    const broken = new MemoryWriter(facts, confirmer, async () => { throw new Error("down"); });
    await broken.ingest("u1", "I always drink coffee at 9am");
    expect(confirms).toBe(2);
  });

  it("does not write maybe-salient text without a confirmer", async () => {
    const writer = new MemoryWriter(facts);
    expect(await writer.ingest("u1", "I always drink coffee")).toEqual([]);
    expect(facts.all("u1")).toEqual([]);
  });
});
