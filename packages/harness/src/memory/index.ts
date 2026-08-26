export {
  assessSalience,
  type CandidateFact,
  type FactKind,
  type SalienceResult,
  type SalienceVerdict,
} from "./salience.js";
export { FactsStore, type Fact } from "./facts.js";
export { MemoryWriter, type SalienceConfirmer } from "./writer.js";
export { LlmSalienceConfirmer, parseConfirmerReply } from "./confirmer.js";
export {
  CohereEmbeddingProvider,
  HashingEmbeddingProvider,
  OpenAIEmbeddingProvider,
  isSemantic,
  type CohereEmbeddingOptions,
  type EmbedMode,
  type EmbeddingProvider,
  type OpenAIEmbeddingOptions,
} from "./embeddings.js";
export {
  EpisodicStore,
  type Episode,
  type EpisodeHit,
} from "./episodic.js";
export {
  MemoryRetriever,
  type Recall,
  type RecallOptions,
} from "./retriever.js";
