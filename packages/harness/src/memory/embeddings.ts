import OpenAI from "openai";

/**
 * Embedding provider, modular like the model router: swappable local or cloud,
 * keys via the secrets system. Vectors feed the sqlite-vec episodic store.
 */
/**
 * Whether these texts are being stored or used as a search query. Some
 * providers (Cohere) embed the two asymmetrically and lose accuracy if the
 * distinction is dropped; providers that do not care ignore it.
 */
export type EmbedMode = "document" | "query";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(texts: string[], mode?: EmbedMode): Promise<number[][]>;
}

/**
 * True when the provider is a real semantic embedder. The hashing fallback is
 * lexical, so callers can tell the user rather than implying semantic recall
 * that is not there.
 */
export function isSemantic(provider: EmbeddingProvider): boolean {
  return provider.name !== "hashing";
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

export interface CohereEmbeddingOptions {
  apiKey: string;
  /** Embedding model id, e.g. "embed-english-v3.0". */
  model: string;
  dimension: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const COHERE_ENDPOINT = "https://api.cohere.com/v2/embed";

/**
 * Cloud embeddings via Cohere. Present so an Anthropic-only .env still gets
 * real semantic recall instead of silently falling back to lexical hashing.
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name = "cohere";

  constructor(private readonly options: CohereEmbeddingOptions) {}

  get dimension(): number {
    return this.options.dimension;
  }

  async embed(texts: string[], mode: EmbedMode = "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const doFetch = this.options.fetchImpl ?? fetch;
    const res = await doFetch(COHERE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        texts,
        input_type: mode === "query" ? "search_query" : "search_document",
        embedding_types: ["float"],
        output_dimension: this.options.dimension,
      }),
    });
    if (!res.ok) {
      throw new Error(`cohere embed failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      embeddings?: { float?: number[][] };
    };
    const vectors = body.embeddings?.float;
    if (!Array.isArray(vectors)) {
      throw new Error("cohere embed returned no float embeddings");
    }
    return vectors;
  }
}
