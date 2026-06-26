import type { FactsStore } from "./facts.js";
import { assessSalience, type CandidateFact } from "./salience.js";

/**
 * Optional LLM confirmation pass for "maybe"-salient text. Runs only on what
 * the heuristics flag as uncertain, to confirm and structure it. Returns the
 * facts to actually persist (possibly empty).
 */
export interface SalienceConfirmer {
  confirm(text: string, candidates: CandidateFact[]): Promise<CandidateFact[]>;
}

/**
 * The salience write path: assess text, persist obvious durables immediately,
 * and route uncertain cases through the confirmer when one is provided. Returns
 * the facts written, for the memory-peek UI and tests.
 */
export class MemoryWriter {
  constructor(
    private readonly facts: FactsStore,
    private readonly confirmer?: SalienceConfirmer,
  ) {}

  async ingest(
    userId: string,
    text: string,
    source: string | null = null,
  ): Promise<CandidateFact[]> {
    const result = assessSalience(text);

    if (result.verdict === "skip") return [];

    let toWrite: CandidateFact[] = [];
    if (result.verdict === "durable") {
      toWrite = result.candidates;
    } else if (result.verdict === "maybe" && this.confirmer) {
      toWrite = await this.confirmer.confirm(text, result.candidates);
    }

    for (const fact of toWrite) {
      this.facts.upsert(userId, fact, source);
    }
    return toWrite;
  }
}
