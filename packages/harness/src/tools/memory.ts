import type { FactsStore } from "../memory/facts.js";
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
] as const;

export interface MemoryToolDeps {
  facts: FactsStore;
  ownerId: string;
  /** Which conversation is writing, recorded as the entry's source. */
  currentSource?: () => string;
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
        },
        required: ["key", "value"],
      },
    },
    (input) => {
      const key = normalizeKey(str(input, "key"));
      const tags = stringList(input, "tags");
      facts.upsert(
        ownerId,
        {
          key,
          value: str(input, "value"),
          kind: input.kind === "preference" ? "preference" : "fact",
          ...(tags.length ? { tags } : {}),
          ...(typeof input.pinned === "boolean" ? { pinned: input.pinned } : {}),
        },
        source(),
      );
      return JSON.stringify({ remembered: key });
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
        },
      },
    },
    (input) => {
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.min(100, Math.floor(input.limit))
          : 20;
      const tags = stringList(input, "tags");
      const query = typeof input.query === "string" ? input.query : "";
      const hits = facts.search(ownerId, query, limit, {
        ...(tags.length ? { tags } : {}),
      });
      return JSON.stringify(
        hits.map((f) => ({
          key: f.key,
          value: f.value,
          kind: f.kind,
          tags: f.tags,
          pinned: f.pinned,
          source: f.source,
        })),
      );
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
      return JSON.stringify({ key, removed: facts.delete(ownerId, key) });
    },
    // One key at a time, no bulk delete, and the nightly git snapshot covers
    // undo. Making this risky would put an approval in front of routine
    // correction, which is how memory goes stale.
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
