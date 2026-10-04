import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { EventLog } from "../memory/events.js";
import { BATCH_CHARS, relatedClaims, takeBatch } from "../memory/extractor.js";
import { GLOBAL_SCOPE, projectScope, type FactsStore } from "../memory/facts.js";
import { listPages, readPage, writePage } from "../memory/pages.js";
import type { ReviewQueue } from "../memory/review.js";
import type { KosModule, ModuleContext } from "../modules/loader.js";
import { requireServices } from "../modules/loader.js";

/**
 * The `memory` tool module: deliberate, shared, persistent knowledge.
 *
 * Until now memory was written only by a salience heuristic watching the
 * owner's messages, so an agent could not record anything it worked out. A
 * conversation would establish something, end, and lose it.
 *
 * The store is shared: every conversation reads and writes the same knowledge,
 * so what one agent learns is available to the next. Keys are stable
 * identifiers, not sentences, because a second write to the same key updates
 * rather than duplicates.
 */

export const MEMORY_TOOLS = [
  "memory.remember",
  "memory.recall",
  "memory.forget",
  "memory.tags",
  "memory.trace",
  "memory.unread",
  "memory.mark_read",
  "memory.review",
  "memory.merge",
  "memory.archive",
  "memory.flag",
  "memory.page",
  "memory.pages",
] as const;

export interface MemoryToolDeps {
  facts: FactsStore;
  /** The log, for recall with history. Optional so the tools work without it. */
  events?: EventLog;
  embedder?: EmbeddingProvider;
  ownerId: string;
  /** Which conversation is writing, recorded as the entry's source. */
  currentSource?: () => string;
  /** The project the writing conversation is in, the default scope of a claim made there. */
  currentProject?: () => string | undefined;
  /** How far the log has been read for memory, shared with the fixed extractor. */
  watermark?: { get: () => number; set: (lastEventId: number) => void };
  /** Where the dream job leaves what it could not settle. */
  review?: ReviewQueue;
  /** Days without use before a claim counts as stale. */
  staleDays?: number;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new Error(`missing arg: ${key}`);
  return v;
}

function stringList(input: Record<string, unknown>, key: string): string[] {
  const v = input[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Keys are identifiers so a restatement updates instead of accumulating. */
function normalizeKey(raw: string): string {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!key) throw new Error("key must contain letters or numbers");
  return key;
}

const KINDS = ["fact", "preference"] as const;

function defineMemoryTools(deps: MemoryToolDeps, ctx: ModuleContext): void {
  const { facts, ownerId } = deps;
  const source = (): string => deps.currentSource?.() ?? "agent";
  /*
   * Event ids each conversation has been shown, by memory.unread or recall
   * with history. Evidence on a remember must come from here: a claim may
   * only cite what its writer actually read, which is what makes "where
   * did this come from" an answer rather than a guess.
   */
  const shown = new Map<string, Set<number>>();
  const show = (ids: number[]): void => {
    const set = shown.get(source()) ?? new Set<number>();
    for (const id of ids) set.add(id);
    shown.set(source(), set);
  };
  /** "global", "project" (this one), or a project slug; the project in play by default. */
  const scopeOf = (raw: unknown): string => {
    const here = deps.currentProject?.();
    if (raw === "global") return GLOBAL_SCOPE;
    if (typeof raw === "string" && raw.trim() && raw !== "project") return projectScope(raw.trim());
    return here ? projectScope(here) : GLOBAL_SCOPE;
  };

  ctx.registerTool(
    {
      name: "memory.remember",
      description:
        "Record something worth knowing later, for yourself and for every other conversation. Use it for durable things: decisions made, constraints, how the owner wants something done, where something lives. Not for what is already in this conversation. Re-using a key updates that entry rather than adding a second one.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "stable identifier, e.g. deploy_target or coffee_order",
          },
          value: { type: "string", description: "the thing to remember, self-contained" },
          kind: { type: "string", enum: [...KINDS] },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "labels for grouping, e.g. [\"budget\"] or [\"infra\"]",
          },
          pinned: {
            type: "boolean",
            description:
              "put it in every conversation's context without needing a match. Reserve for the few things that always apply.",
          },
          scope: {
            type: "string",
            description:
              'where it is true: "global" for something about the owner everywhere; "project" (the default inside a project chat) or a project slug for something about that project only',
          },
          evidence: {
            type: "array",
            items: { type: "number" },
            description: "ids of the events this came from, as memory.unread or memory.recall with history gave them to you",
          },
        },
        required: ["key", "value"],
      },
    },
    (input) => {
      const key = normalizeKey(str(input, "key"));
      const tags = stringList(input, "tags");
      const evidence = Array.isArray(input.evidence) ? input.evidence.filter((x): x is number => typeof x === "number") : [];
      const seen = shown.get(source());
      const unseen = evidence.filter((id) => !seen?.has(id));
      if (unseen.length) {
        throw new Error(`evidence must be event ids you were shown by memory.unread or memory.recall; not shown: ${unseen.join(", ")}`);
      }
      const cited = evidence.map((id) => deps.events?.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined);
      // The owner's own words, cited, make an owner-trust claim; anything
      // else is the agent's belief until the owner says it.
      const trust = cited.length && cited.every((e) => e.role === "owner") ? "owner" : "agent";
      const written = facts.upsert(
        ownerId,
        {
          key,
          value: str(input, "value"),
          kind: input.kind === "preference" ? "preference" : "fact",
          scope: scopeOf(input.scope),
          trust,
          ...(evidence.length ? { evidence } : {}),
          ...(tags.length ? { tags } : {}),
          ...(typeof input.pinned === "boolean" ? { pinned: input.pinned } : {}),
        },
        source(),
      );
      return JSON.stringify({ remembered: key, scope: written.scope, trust, ...(written.supersedes ? { replaced: true } : {}) });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.recall",
      description:
        "Look through what is known. Salient entries are already in your context; use this to go deeper, to check before assuming, or to list everything under a tag.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "omit to list by recency" },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
          history: { type: "boolean", description: "also search everything that was said, by words and meaning, with when and where" },
        },
      },
    },
    async (input) => {
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.min(100, Math.floor(input.limit))
          : 20;
      const tags = stringList(input, "tags");
      const query = typeof input.query === "string" ? input.query : "";
      const hits = facts.search(ownerId, query, limit, {
        ...(tags.length ? { tags } : {}),
      });
      const found = hits.map((f) => ({
        key: f.key,
        value: f.value,
        kind: f.kind,
        tags: f.tags,
        pinned: f.pinned,
        source: f.source,
      }));
      if (input.history === true && deps.events && query) {
        const [embedding] = deps.embedder ? await deps.embedder.embed([query], "query") : [undefined];
        const hits = deps.events.search({ userId: ownerId, query, ...(embedding ? { embedding } : {}), k: limit });
        show(hits.map((e) => e.id));
        const history = hits
          .map((e) => ({
            id: e.id,
            when: new Date(e.ts).toISOString(),
            who: e.role,
            ...(e.projectSlug ? { project: e.projectSlug } : {}),
            ...(e.conversationId ? { conversation: e.conversationId } : {}),
            text: e.text.slice(0, 500),
          }));
        return JSON.stringify({ found, history });
      }
      /*
       * An empty array reads as "nothing is known", and the reply that
       * follows says so. Usually the words were wrong rather than the store
       * being empty, so a miss reports what there is to aim at instead: the
       * tags in use and how much is stored under them.
       */
      if (found.length === 0) {
        const known = facts.tags(ownerId);
        return JSON.stringify({
          found,
          searched: query || "(everything, by recency)",
          stored: facts.all(ownerId).length,
          tags: known,
          hint:
            "Nothing matched those words. Search again with a single plain noun, or list a tag.",
        });
      }
      return JSON.stringify(found);
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.tags",
      description:
        "List the tags in use, to see how knowledge is organised before adding to it.",
      inputSchema: { type: "object", properties: {} },
    },
    () => JSON.stringify(facts.tags(ownerId)),
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.forget",
      description:
        "Remove one entry by key, when it is wrong or no longer true. Correcting a wrong entry with memory.remember is usually better than forgetting it.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
    (input) => {
      const key = normalizeKey(str(input, "key"));
      const gone = facts.delete(ownerId, key);
      // Forgotten means gone: the words it was drawn from leave the log too,
      // or a search by meaning would hand it straight back.
      if (gone.evidence.length) deps.events?.redact(gone.evidence);
      return JSON.stringify({ key, removed: gone.removed, ...(gone.evidence.length ? { redactedEvents: gone.evidence.length } : {}) });
    },
    // One key at a time, no bulk delete, and the nightly git snapshot covers
    // undo. Making this risky would put an approval in front of routine
    // correction, which is how memory goes stale.
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.unread",
      description:
        "What has been said since memory was last read: new events with ids, and the claims already remembered that might relate. Read it, keep what matters with memory.remember and evidence, then memory.mark_read with the cursor.",
      inputSchema: {
        type: "object",
        properties: { chars: { type: "number", description: "how much to read at once, in characters (default 6000)" } },
      },
    },
    (input) => {
      if (!deps.events || !deps.watermark) throw new Error("memory.unread needs the events log");
      const chars = typeof input.chars === "number" && input.chars > 500 ? Math.min(input.chars, 40_000) : BATCH_CHARS;
      const fresh = deps.events.since(ownerId, deps.watermark.get(), 500);
      const batch = takeBatch(fresh, chars);
      show(batch.map((e) => e.id));
      const related = relatedClaims(facts, ownerId, batch);
      return JSON.stringify({
        events: batch.map((e) => ({
          id: e.id,
          when: new Date(e.ts).toISOString(),
          who: e.role,
          ...(e.projectSlug ? { project: e.projectSlug } : {}),
          text: e.text.slice(0, 1500),
        })),
        related: related.map((f) => ({ key: f.key, scope: f.scope, kind: f.kind, value: f.value })),
        cursor: batch.length ? batch[batch.length - 1]!.id : deps.watermark.get(),
        remaining: Math.max(0, fresh.length - batch.length),
      });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.mark_read",
      description: "Say memory has been read through a cursor from memory.unread, so the next read starts after it.",
      inputSchema: { type: "object", properties: { cursor: { type: "number" } }, required: ["cursor"] },
    },
    (input) => {
      if (!deps.watermark) throw new Error("memory.mark_read needs the events log");
      const cursor = typeof input.cursor === "number" ? Math.floor(input.cursor) : NaN;
      if (!Number.isFinite(cursor)) throw new Error("cursor must be an event id from memory.unread");
      const current = deps.watermark.get();
      if (cursor > current) deps.watermark.set(cursor);
      return JSON.stringify({ readThrough: Math.max(cursor, current) });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  const scopeArg = (raw: unknown): string => (typeof raw === "string" && raw.trim() ? (raw.trim() === "global" ? GLOBAL_SCOPE : raw.trim().startsWith("project:") || raw.trim().startsWith("caller:") ? raw.trim() : projectScope(raw.trim())) : GLOBAL_SCOPE);
  const brief = (f: { key: string; scope: string; kind: string; value: string; trust: string; createdAt: number; lastUsedAt: number | null; useCount: number }) => ({
    key: f.key, scope: f.scope, kind: f.kind, value: f.value, trust: f.trust,
    since: new Date(f.createdAt).toISOString().slice(0, 10),
    lastUsed: f.lastUsedAt ? new Date(f.lastUsedAt).toISOString().slice(0, 10) : null,
    used: f.useCount,
  });

  ctx.registerTool(
    {
      name: "memory.review",
      description:
        "What memory tidying has to look at: pairs of claims that may be one thing or may disagree, claims nobody has used for a long time, and the pages that exist. For the dream job; decide with memory.merge, memory.archive, memory.flag and memory.page.",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const ws = requireServices(ctx).workspace;
      const staleMs = (deps.staleDays ?? 60) * 86_400_000;
      return JSON.stringify({
        pairs: facts.pairs(ownerId).map((p) => ({ why: p.why, a: brief(p.a), b: brief(p.b) })),
        stale: facts.stale(ownerId, staleMs).slice(0, 50).map(brief),
        pages: listPages(ws).map((p) => ({ name: p.name, updated: new Date(p.updatedAt).toISOString().slice(0, 10) })),
        projects: [...new Set(facts.all(ownerId).map((f) => f.scope).filter((s) => s.startsWith("project:")))],
        pending: deps.review?.pending().length ?? 0,
      });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.merge",
      description:
        "Two claims are one thing: keep one, fold the other into it. The dropped claim is closed, its evidence moves across, both are on the record. Keys are scope-qualified by the scope arguments.",
      inputSchema: {
        type: "object",
        properties: {
          keep: { type: "string" }, keepScope: { type: "string", description: "global, or a project slug" },
          drop: { type: "string" }, dropScope: { type: "string" },
          value: { type: "string", description: "optionally the better wording for the kept claim" },
        },
        required: ["keep", "drop"],
      },
    },
    (input) => {
      const keep = { key: normalizeKey(str(input, "keep")), scope: scopeArg(input.keepScope) };
      const drop = { key: normalizeKey(str(input, "drop")), scope: scopeArg(input.dropScope) };
      const kept = facts.merge(ownerId, keep, drop, source());
      if (!kept) throw new Error("one of those claims is not current, or they are the same claim");
      if (typeof input.value === "string" && input.value.trim() && input.value.trim() !== kept.value) {
        facts.upsert(ownerId, { key: kept.key, value: input.value.trim(), kind: kept.kind, scope: kept.scope }, source());
      }
      return JSON.stringify({ kept: `${keep.scope}/${keep.key}`, dropped: `${drop.scope}/${drop.key}` });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.archive",
      description: "Put a stale claim away without forgetting it: out of recall, kept in history with the reason.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, scope: { type: "string" }, reason: { type: "string" } }, required: ["key", "reason"] },
    },
    (input) => {
      const key = normalizeKey(str(input, "key"));
      const scope = scopeArg(input.scope);
      const archived = facts.archive(ownerId, key, scope, source(), str(input, "reason"));
      if (!archived) throw new Error(`no current claim ${scope}/${key}`);
      return JSON.stringify({ archived: `${scope}/${key}` });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.flag",
      description: "Leave something for the owner to decide: a contradiction you cannot settle, or a project claim that should become global. Say which claims and why in one line.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["contradiction", "promotion", "other"] },
          keys: { type: "array", items: { type: "string" }, description: "scope-qualified keys, e.g. global/city, project:pantry/city" },
          note: { type: "string" },
        },
        required: ["kind", "keys", "note"],
      },
    },
    (input) => {
      if (!deps.review) throw new Error("no review queue");
      const kind = input.kind === "contradiction" || input.kind === "promotion" ? input.kind : "other";
      const keys = stringList(input, "keys");
      if (keys.length === 0) throw new Error("keys is required");
      const item = deps.review.add(kind, keys, str(input, "note"));
      return JSON.stringify({ flagged: item.id, kind: item.kind, keys: item.keys });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.page",
      description: "Write a page the owner can read: memory/<name>.md, rendered from current claims. profile for the owner everywhere, a project slug for that project.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, markdown: { type: "string" } }, required: ["name", "markdown"] },
    },
    (input) => {
      const ws = requireServices(ctx).workspace;
      const page = writePage(ws, str(input, "name"), str(input, "markdown"));
      return JSON.stringify({ wrote: page.path, bytes: page.bytes });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.pages",
      description: "The pages memory has written, or one page's text when a name is given.",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
    },
    (input) => {
      const ws = requireServices(ctx).workspace;
      if (typeof input.name === "string" && input.name.trim()) {
        const text = readPage(ws, input.name.trim());
        return text ?? JSON.stringify({ name: input.name, exists: false });
      }
      return JSON.stringify(listPages(ws).map((p) => ({ name: p.name, path: p.path, updated: new Date(p.updatedAt).toISOString() })));
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );

  ctx.registerTool(
    {
      name: "memory.trace",
      description:
        "Where a belief came from: the current claim under a key, what it replaced and when, who wrote each, and the moments in the log it was drawn from. Use it before contradicting the owner about something remembered.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    (input) => {
      const key = normalizeKey(str(input, "key"));
      const claim = facts.get(ownerId, key);
      if (!claim) return JSON.stringify({ key, known: false, history: facts.history(ownerId, key).length });
      const trace = facts.trace(claim.id)!;
      const evidence = trace.evidence
        .map((id) => deps.events?.get(id))
        .filter((e): e is NonNullable<typeof e> => e !== undefined)
        .map((e) => ({ when: new Date(e.ts).toISOString(), who: e.role, ...(e.projectSlug ? { project: e.projectSlug } : {}), text: e.text.slice(0, 300) }));
      return JSON.stringify({
        key,
        value: claim.value,
        scope: claim.scope,
        trust: claim.trust,
        source: claim.source,
        since: new Date(claim.createdAt).toISOString(),
        before: trace.before.map((b) => ({ value: b.value, from: new Date(b.createdAt).toISOString(), until: b.supersededAt ? new Date(b.supersededAt).toISOString() : null, source: b.source })),
        evidence,
      });
    },
    { floor: "safe" },
    { tags: ["memory"] },
  );
}

export function createMemoryModule(deps: MemoryToolDeps): KosModule {
  return {
    manifest: {
      name: "memory",
      version: "1.0.0",
      provides: MEMORY_TOOLS.map((name) => ({
        kind: "tool" as const,
        name,
        version: "1.0.0",
      })),
      riskTier: "safe",
    },
    activate(ctx) {
      requireServices(ctx);
      defineMemoryTools(deps, ctx);
    },
  };
}
