import type { EmbeddingProvider } from "./embeddings.js";
import { deadline } from "../context/shelf.js";
import type { EventHit, EventLog } from "./events.js";
import { GLOBAL_SCOPE, projectScope, type Fact, type FactsStore } from "./facts.js";
import { onePerKey, withinChars } from "./rank.js";

/** The things every turn knows unmatched (pinned, the owner's preferences), at most. */
export const STANDING_LIMIT = 8;
/** The claims a turn's words matched, at most: their own room, which standing ones never take. */
export const MATCHED_LIMIT = 10;
/** The most characters of matched claims a turn is given, keys and values, past the first. */
export const MATCHED_CHARS = 3000;

/**
 * A turn's claims: what stands, then what the words matched, each within its
 * own budget. They shared one slice of twelve, and four pinned entries and
 * eight preferences left no room for a single claim the message was about.
 * A key that stands is not matched again, in any scope: one answer per key.
 */
export function withStanding(standing: Fact[], matched: Fact[]): Fact[] {
  const kept = standing.slice(0, STANDING_LIMIT);
  const rest = matched.filter((f) => !kept.some((s) => s.key === f.key)).slice(0, MATCHED_LIMIT);
  return [...kept, ...withinChars(rest, MATCHED_CHARS)];
}

export interface Recall {
  facts: Fact[];
  /** Moments from the log that read like the query, newest and nearest first. */
  events: EventHit[];
}

export interface RecallOptions {
  factLimit?: number;
  eventLimit?: number;
  /** The project in play: its claims are read beside the global ones, and its events rank a little higher. */
  projectSlug?: string | null;
  /** Lowest keyword score a claim needs to be injected. Retrieved is not injected. */
  minScore?: number;
  /** Extra scopes to read, for an outside caller's own claims. */
  scopes?: string[];
  /**
   * These scopes alone: no global claims and no moments from the log, which
   * are the owner's own. A guest's work reads its room's project this way.
   */
  only?: string[];
  /** Only the claims these wrote, by source: a room's guests are matched what the room itself wrote, never the owner's chats. */
  sources?: string[];
}

/**
 * What a turn gets to remember: the facts whose words match, and the
 * moments from the log that match by words or by meaning. Both, every
 * turn. The log used to be consulted only when no fact matched, which
 * meant one matching word hid everything that had ever been said.
 */
export class MemoryRetriever {
  constructor(
    private readonly facts: FactsStore,
    private readonly events?: EventLog,
    private readonly embedder?: EmbeddingProvider,
  ) {}

  async recall(userId: string, query: string, options: RecallOptions = {}): Promise<Recall> {
    const scopes = options.only ?? [GLOBAL_SCOPE, ...(options.projectSlug ? [projectScope(options.projectSlug)] : []), ...(options.scopes ?? [])];
    // One answer per key, within the turn's budget, before use is counted: a claim cut here was never in front of the model.
    const facts = withinChars(onePerKey(this.facts.search(userId, query, options.factLimit ?? 10, {
      scopes,
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
      ...(options.sources ? { sources: options.sources } : {}),
    })), MATCHED_CHARS);
    this.facts.markUsed(facts.map((f) => f.id));
    let events: EventHit[] = [];
    if (this.events && query.trim() && !options.only) {
      // Recall goes on by words alone when the embedding cannot be had in time: the turn should not wait on it.
      const [embedding] = this.embedder ? ((await Promise.race([this.embedder.embed([query], "query").catch(() => undefined), deadline(10_000)])) ?? [undefined]) : [undefined];
      events = this.events.search({
        userId,
        query,
        ...(embedding ? { embedding } : {}),
        k: options.eventLimit ?? 5,
        projectSlug: options.projectSlug ?? null,
      });
    }
    return { facts, events };
  }
}
