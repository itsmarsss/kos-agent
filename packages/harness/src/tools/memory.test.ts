import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../agent/registry.js";
import { HashingEmbeddingProvider } from "../memory/embeddings.js";
import { EventLog } from "../memory/events.js";
import { FactsStore } from "../memory/facts.js";
import { ObservationStore } from "../memory/observations.js";
import { ReviewQueue } from "../memory/review.js";
import { SessionStore } from "../kernel/session.js";
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
  let reviewQueue: ReviewQueue;
  let sessions: SessionStore;
  let busy: string[];

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
    reviewQueue = new ReviewQueue(ws.db);
    sessions = new SessionStore(ws.db, { autoTrim: false, maxChars: 1250 });
    busy = [];
    registry = new ToolRegistry();
    await createMemoryModule({
      facts,
      events,
      embedder,
      review: reviewQueue,
      threads: {
        sessions,
        conversations: { list: () => [{ id: "chat:long", title: "Long", projectSlug: null }, { id: "chat:short", title: "Short", projectSlug: null }] },
        observations: new ObservationStore(ws.db),
        busy: () => busy,
      },
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

  it("gives the dream job its candidates and takes its decisions", async () => {
    facts.upsert("owner", { key: "city", value: "Montreal", kind: "fact" });
    facts.upsert("owner", { key: "home_city", value: "Montreal, Plateau", kind: "fact" });
    facts.upsert("owner", { key: "trip", value: "maybe Lisbon in May", kind: "fact" });
    facts.upsert("owner", { key: "city", value: "Lisbon", kind: "fact", scope: "project:trip" });
    const review = (await call("memory.review")).json!;
    // city vs project city (same key), city vs home_city and project city vs home_city (a shared word).
    expect((review["pairs"] as { why: string }[]).map((p) => p.why).sort()).toEqual(["same_key", "shared_word", "shared_word"]);
    expect(review["projects"]).toEqual(["project:trip"]);
    expect((await call("memory.merge", { keep: "city", drop: "home_city" })).json).toEqual({ kept: "global/city", dropped: "global/home_city" });
    expect(facts.get("owner", "home_city")).toBeUndefined();
    expect((await call("memory.archive", { key: "trip", reason: "a plan, not a fact" })).json).toEqual({ archived: "global/trip" });
    expect(facts.get("owner", "trip")).toBeUndefined();
    const flagged = (await call("memory.flag", { kind: "contradiction", keys: ["global/city", "project:trip/city"], note: "Montreal or Lisbon?" })).json!;
    expect(flagged).toMatchObject({ kind: "contradiction", keys: ["global/city", "project:trip/city"] });
    expect(reviewQueue.pending()).toHaveLength(1);
    expect((await call("memory.page", { name: "profile", markdown: "# Owner\n- city: Montreal" })).json).toMatchObject({ wrote: "memory/profile.md" });
    // A page comes back as its text, not JSON.
    expect((await registry.execute("memory.pages", { name: "profile" })).content).toContain("city: Montreal");
    expect((await call("memory.page", { name: "../x", markdown: "no" })).isError).toBe(true);
    for (const safe of ["memory.review", "memory.merge", "memory.archive", "memory.flag", "memory.page", "memory.pages", "memory.threads", "memory.thread", "memory.observe"]) {
      expect(registry.classify(safe, {}).tier).toBe("safe");
    }
  });

  it("finds long threads, shows the part a note would cover, and stands the note in for it", async () => {
    const say = (n: number): { role: "user" | "assistant"; content: { type: "text"; text: string }[] }[] => [
      { role: "user", content: [{ type: "text", text: `question ${n} ${"x".repeat(80)}` }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] },
    ];
    const history = Array.from({ length: 8 }, (_, i) => say(i + 1)).flat();
    sessions.set("chat:long", history);
    sessions.set("chat:short", say(1));
    for (let i = 1; i <= 8; i++) {
      events.append({ userId: "owner", role: "owner", text: `question ${i}`, conversationId: "chat:long" });
      events.append({ userId: "owner", role: "agent", text: `answer ${i}`, conversationId: "chat:long" });
    }
    const threads = (await call("memory.threads")).json!;
    expect((threads["threads"] as { id: string; messages: number }[]).map((t) => [t.id, t.messages])).toEqual([["chat:long", 16]]);
    busy = ["chat:long"];
    expect((await call("memory.threads")).json!["threads"]).toEqual([]);
    busy = [];
    const older = (await call("memory.thread", { id: "chat:long" })).json!;
    expect(older).toMatchObject({ covering: 4, keeping: 4 });
    expect((older["turns"] as { text: string }[]).map((t) => t.text.slice(0, 10))).toEqual(["question 1", "answer 1", "question 2", "answer 2", "question 3", "answer 3", "question 4", "answer 4"]);
    const done = (await call("memory.observe", { id: "chat:long", note: "The owner asked four questions; all answered." })).json!;
    expect(done).toMatchObject({ observed: "chat:long", seq: 1, covered: 8, kept: 8 });
    const after = sessions.get("chat:long");
    expect(after).toHaveLength(9);
    expect((after[0]!.content[0] as { text: string }).text).toContain("[Earlier in this conversation]");
    expect((after[0]!.content[0] as { text: string }).text).toContain("all answered");
    expect((after[1]!.content[0] as { text: string }).text).toContain("question 5");
    // The covered events are shadowed, the kept ones are not, and the words are all still there.
    const log = events.recent("chat:long", 100);
    expect(log.filter((e) => e.shadowed).length).toBe(8);
    expect(log.slice(-8).every((e) => !e.shadowed)).toBe(true);
    expect(events.search({ userId: "owner", query: "question 2" }).length).toBeGreaterThan(0);
    // Too short to cover anything.
    expect((await call("memory.observe", { id: "chat:short", note: "x" })).isError).toBe(true);
    // A second note joins the first in the prefix.
    sessions.set("chat:long", [...sessions.get("chat:long"), ...Array.from({ length: 5 }, (_, i) => say(i + 9)).flat()]);
    const again = (await call("memory.observe", { id: "chat:long", note: "Then five more." })).json!;
    expect(again).toMatchObject({ seq: 2 });
    expect((sessions.get("chat:long")[0]!.content[0] as { text: string }).text).toMatch(/all answered[\s\S]*Then five more/);
  });

  it("counts recall with history as having shown those events", async () => {
    const [vec] = await embedder.embed(["the pantry app uses sqlite"]);
    const a = events.append({ userId: "owner", role: "owner", text: "the pantry app uses sqlite" }, vec);
    const { json } = await call("memory.recall", { query: "pantry sqlite", history: true });
    expect((json!["history"] as { id: number }[]).map((h) => h.id)).toEqual([a]);
    expect((await call("memory.remember", { key: "pantry_db", value: "sqlite", evidence: [a] })).isError).toBe(false);
  });
});
