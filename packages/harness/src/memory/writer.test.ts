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

  it("does not write maybe-salient text without a confirmer", async () => {
    const writer = new MemoryWriter(facts);
    expect(await writer.ingest("u1", "I always drink coffee")).toEqual([]);
    expect(facts.all("u1")).toEqual([]);
  });
});
