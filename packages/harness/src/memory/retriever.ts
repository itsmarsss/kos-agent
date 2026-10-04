import type { EmbeddingProvider } from "./embeddings.js";
import type { EventHit, EventLog } from "./events.js";
import { GLOBAL_SCOPE, projectScope, type Fact, type FactsStore } from "./facts.js";

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
    const scopes = [GLOBAL_SCOPE, ...(options.projectSlug ? [projectScope(options.projectSlug)] : []), ...(options.scopes ?? [])];
    const facts = this.facts.search(userId, query, options.factLimit ?? 10, {
      scopes,
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    });
    this.facts.markUsed(facts.map((f) => f.id));
    let events: EventHit[] = [];
    if (this.events && query.trim()) {
      const [embedding] = this.embedder ? await this.embedder.embed([query], "query") : [undefined];
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
