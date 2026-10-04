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
  EventLog,
  ftsQuery,
  type EventHit,
  type EventRole,
  type EventSearch,
  type EventTrust,
  type MemoryEvent,
  type NewEvent,
} from "./events.js";
export {
  MemoryRetriever,
  type Recall,
  type RecallOptions,
} from "./retriever.js";
export { MemoryExtractor, parseProposals, EXTRACTOR_KEY, type ExtractionReport, type ExtractorState } from "./extractor.js";
export { runMemoryEval, renderEvalReport, loadGolden, type EvalReport, type GoldenCase, type MemoryReader } from "./eval.js";
export { MEMORY_JOB, MEMORY_JOB_PROMPT, MEMORY_JOB_SCHEDULE, ensureDefaultMemoryCron } from "./job.js";
export { relatedClaims, takeBatch } from "./extractor.js";
