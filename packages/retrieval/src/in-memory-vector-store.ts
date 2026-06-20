import type { VectorChunk, VectorHit, VectorStore } from './contracts.js';

/**
 * A `VectorStore` that ranks by cosine similarity over an in-memory array.
 *
 * This is the "build the whole pipeline with zero cloud" adapter: index a few
 * docs, query, rank, return chunks. `PgVectorStore` is a later drop-in behind the
 * same contract — no pipeline change.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly dimension: number;
  private readonly chunks = new Map<string, VectorChunk>();

  constructor(dimension: number) {
    this.dimension = dimension;
  }

  async upsert(chunks: VectorChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
      this.chunks.set(chunk.id, chunk);
    }
  }

  async search(vector: number[], k: number): Promise<VectorHit[]> {
    this.assertDimension(vector, 'query vector');
    const hits: VectorHit[] = [];
    for (const chunk of this.chunks.values()) {
      hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, k));
  }

  /** Fail loudly on a dimension mismatch — a silent mismatch corrupts ranking. */
  private assertDimension(vector: number[], label: string): void {
    if (vector.length !== this.dimension) {
      throw new Error(
        `dimension mismatch: ${label} has length ${vector.length}, store expects ${this.dimension}`,
      );
    }
  }
}

/** Cosine similarity in [-1, 1]; 0 for a zero-length vector to avoid NaN. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
