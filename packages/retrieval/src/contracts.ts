/**
 * The two adaptability seams of the RAG pipeline. Embedding vendor and vector
 * store are swappable adapters behind these contracts — the pipeline logic never
 * names a vendor (nomic / OpenAI / pgvector / in-memory are incidental).
 */

/** A vector chunk as stored: stable id, its embedding, and arbitrary metadata. */
export type VectorChunk = {
  id: string;
  vector: number[];
  meta: Record<string, unknown>;
};

/** A ranked search hit: the chunk id, its similarity score, and its metadata. */
export type VectorHit = {
  id: string;
  score: number;
  meta: Record<string, unknown>;
};

/** Turns text into embeddings. `dimension` is fixed per provider (768 = nomic). */
export type EmbeddingProvider = {
  id: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
};

/**
 * Stores and searches embeddings. Carries its own `dimension`: a corpus embedded
 * at one dimension cannot be searched by a query of another, so the store rejects
 * any vector whose length does not match — loudly.
 */
export type VectorStore = {
  dimension: number;
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
