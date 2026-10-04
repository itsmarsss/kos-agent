import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { HashingEmbeddingProvider } from "../memory/embeddings.js";
import { EventLog } from "../memory/events.js";
import { FactsStore } from "../memory/facts.js";
import { toolRegistryContext } from "../modules/loader.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Workspace } from "../store/workspace.js";
import { createMemoryModule } from "./memory.js";

describe("memory tools: reading the log and citing it", () => {
  const embedder = new HashingEmbeddingProvider(32);
  let root: string;
  let ws: Workspace;
  let events: EventLog;
  let facts: FactsStore;
  let registry: ToolRegistry;
  let watermark: number;
  let where: string;

  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const res = await registry.execute(name, input);
    return { ...res, json: res.isError ? undefined : (JSON.parse(res.content) as Record<string, unknown>) };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-memtools-"));
    ws = Workspace.open(root);
    events = new EventLog(ws.db, embedder.dimension, Date.now, embedder.name);
    facts = new FactsStore(ws.db);
    watermark = 0;
    where = "cron:9";
    registry = new ToolRegistry();
    await createMemoryModule({
      facts,
      events,
      embedder,
      ownerId: "owner",
      currentSource: () => where,
      currentProject: () => undefined,
      watermark: { get: () => watermark, set: (id) => { watermark = id; } },
    }).activate(toolRegistryContext(registry, { workspace: ws, db: ws.db, secrets: new SecretsRegistry() }));
  });
  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("hands over what is unread with the claims that relate, and a cursor to mark", async () => {
    facts.upsert("owner", { key: "city", value: "Toronto", kind: "fact" });
    const a = events.append({ userId: "owner", role: "owner", text: "I moved to Montreal from Toronto", projectSlug: "life" });
    const b = events.append({ userId: "owner", role: "agent", text: "Noted, Montreal." });
    const { json } = await call("memory.unread");
    expect((json!["events"] as { id: number; who: string; project?: string }[]).map((e) => [e.id, e.who, e.project])).toEqual([[a, "owner", "life"], [b, "agent", undefined]]);
    expect((json!["related"] as { key: string }[]).map((r) => r.key)).toEqual(["city"]);
    expect(json!).toMatchObject({ cursor: b, remaining: 0 });
    expect((await call("memory.mark_read", { cursor: b })).json).toEqual({ readThrough: b });
    expect(watermark).toBe(b);
    expect((await call("memory.unread")).json).toMatchObject({ events: [], cursor: b });
    // A cursor behind the watermark does not move it back.
    await call("memory.mark_read", { cursor: a });
    expect(watermark).toBe(b);
  });

  it("takes evidence only for events it showed this conversation, and trusts the owner's words", async () => {
    const a = events.append({ userId: "owner", role: "owner", text: "my sister Nadia is a nurse" });
    const b = events.append({ userId: "owner", role: "agent", text: "I think she lives in Halifax" });
    // Not shown yet: refused.
    const blind = await call("memory.remember", { key: "sister", value: "Nadia", evidence: [a] });
    expect(blind.isError).toBe(true);
    expect(blind.content).toMatch(/not shown: /);
    await call("memory.unread");
    const owner = await call("memory.remember", { key: "sister", value: "Nadia, a nurse", evidence: [a] });
    expect(owner.json).toMatchObject({ remembered: "sister", trust: "owner" });
    const mixed = await call("memory.remember", { key: "sister_city", value: "Halifax", evidence: [a, b] });
    expect(mixed.json).toMatchObject({ trust: "agent" });
    expect(facts.trace(facts.get("owner", "sister")!.id)!.evidence).toEqual([a]);
    // Another conversation was shown nothing.
    where = "chat:other";
    expect((await call("memory.remember", { key: "x", value: "y", evidence: [a] })).isError).toBe(true);
  });

  it("counts recall with history as having shown those events", async () => {
    const [vec] = await embedder.embed(["the pantry app uses sqlite"]);
    const a = events.append({ userId: "owner", role: "owner", text: "the pantry app uses sqlite" }, vec);
    const { json } = await call("memory.recall", { query: "pantry sqlite", history: true });
    expect((json!["history"] as { id: number }[]).map((h) => h.id)).toEqual([a]);
    expect((await call("memory.remember", { key: "pantry_db", value: "sqlite", evidence: [a] })).isError).toBe(false);
  });
});
