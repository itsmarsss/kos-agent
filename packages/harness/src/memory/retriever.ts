import type { EmbeddingProvider } from "./embeddings.js";
import type { EpisodeHit, EpisodicStore } from "./episodic.js";
import type { Fact, FactsStore } from "./facts.js";

export interface Recall {
  facts: Fact[];
  episodes: EpisodeHit[];
}

export interface RecallOptions {
  factLimit?: number;
  episodeLimit?: number;
  /**
   * Only fall back to the vector store when fewer than this many structured
   * facts matched. Default 1: structured-first, vector only when nothing exact
   * was found. Raise it to force episodic recall.
   */
  minFactsBeforeVector?: number;
}

/**
 * Retrieval policy: structured store first (cheap, exact), vector fallback only
 * when the structured tier comes up short. Chatlogs are the last resort and not
 * touched here.
 */
export class MemoryRetriever {
  constructor(
    private readonly facts: FactsStore,
    private readonly episodic?: EpisodicStore,
    private readonly embedder?: EmbeddingProvider,
  ) {}

  async recall(
    userId: string,
    query: string,
    options: RecallOptions = {},
  ): Promise<Recall> {
    const facts = this.facts.search(userId, query, options.factLimit ?? 10);

    let episodes: EpisodeHit[] = [];
    const minFacts = options.minFactsBeforeVector ?? 1;
    if (this.episodic && this.embedder && facts.length < minFacts) {
      const [embedding] = await this.embedder.embed([query]);
      if (embedding) {
        episodes = this.episodic.search(
          userId,
          embedding,
          options.episodeLimit ?? 5,
        );
      }
    }

    return { facts, episodes };
  }
}
