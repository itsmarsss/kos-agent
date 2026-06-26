import OpenAI from "openai";

/**
 * Embedding provider, modular like the model router: swappable local or cloud,
 * keys via the secrets system. Vectors feed the sqlite-vec episodic store.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic, dependency-free embeddings: a hashed bag-of-words projected
 * into a fixed dimension and L2-normalized. Not semantically rich, but real and
 * offline, useful as a local fallback and for tests.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hashing";

  constructor(readonly dimension: number = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const tok of tokens) {
      const i = this.hash(tok) % this.dimension;
      v[i] = (v[i] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return norm === 0 ? v : v.map((x) => x / norm);
  }

  private hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }
}

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  /** Embedding model id, e.g. "text-embedding-3-small". */
  model: string;
  dimension: number;
}

/** Cloud embeddings via the OpenAI embeddings endpoint. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";

  constructor(private readonly options: OpenAIEmbeddingOptions) {}

  get dimension(): number {
    return this.options.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = new OpenAI({ apiKey: this.options.apiKey });
    const res = await client.embeddings.create({
      model: this.options.model,
      input: texts,
      dimensions: this.options.dimension,
    });
    return res.data.map((d) => d.embedding);
  }
}
