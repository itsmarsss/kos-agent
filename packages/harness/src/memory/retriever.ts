import type { EmbeddingProvider } from "./embeddings.js";
import type { EventHit, EventLog } from "./events.js";
import type { Fact, FactsStore } from "./facts.js";

export interface Recall {
  facts: Fact[];
  /** Moments from the log that read like the query, newest and nearest first. */
  events: EventHit[];
}

export interface RecallOptions {
  factLimit?: number;
  eventLimit?: number;
  /** The project in play, whose events rank a little higher. */
  projectSlug?: string | null;
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
    const facts = this.facts.search(userId, query, options.factLimit ?? 10);
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
