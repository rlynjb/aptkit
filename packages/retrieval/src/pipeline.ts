import { chunkText } from './chunker.js';
import type { EmbeddingProvider, VectorHit, VectorStore } from './contracts.js';

/** A source document to index: a stable id, its text, and optional metadata. */
export type RetrievalDocument = {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
};

/** The embedder + store the pipeline functions operate over. */
export type RetrievalWiring = {
  embedder: EmbeddingProvider;
  store: VectorStore;
};

/**
 * Guards the one-way door: a corpus embedded at the provider's dimension can only
 * be searched by a query of the same dimension. A mismatch is a wiring bug, not a
 * runtime input — fail at wiring time, loudly.
 */
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(
      `dimension mismatch: embedder "${wiring.embedder.id}" is ${wiring.embedder.dimension}-dim ` +
        `but store is ${wiring.store.dimension}-dim — re-index the corpus with a matching provider`,
    );
  }
}

/** Index path: doc -> chunk -> embed -> store.upsert. */
export async function indexDocument(
  doc: RetrievalDocument,
  wiring: RetrievalWiring,
): Promise<void> {
  assertWiring(wiring);
  const texts = chunkText(doc.text);
  if (texts.length === 0) return;

  const vectors = await wiring.embedder.embed(texts);
  const chunks = texts.map((text, i) => ({
    id: `${doc.id}#${i}`,
    vector: vectors[i]!,
    meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
  }));
  await wiring.store.upsert(chunks);
}

/** Query path: query -> embed -> store.search -> ranked chunks (score + meta). */
export async function queryKnowledgeBase(
  query: string,
  wiring: RetrievalWiring,
  topK = 5,
): Promise<VectorHit[]> {
  assertWiring(wiring);
  const [vector] = await wiring.embedder.embed([query]);
  if (!vector) return [];
  return wiring.store.search(vector, topK);
}

/** A pipeline with index/query bound to one validated wiring. */
export type RetrievalPipeline = {
  embedder: EmbeddingProvider;
  store: VectorStore;
  index(doc: RetrievalDocument): Promise<void>;
  query(query: string, topK?: number): Promise<VectorHit[]>;
};

/**
 * Wires an embedder to a store. Throws immediately if their dimensions disagree,
 * so a misconfigured pipeline can never silently index unsearchable vectors.
 */
export function createRetrievalPipeline(wiring: RetrievalWiring): RetrievalPipeline {
  assertWiring(wiring);
  return {
    embedder: wiring.embedder,
    store: wiring.store,
    index: (doc) => indexDocument(doc, wiring),
    query: (query, topK) => queryKnowledgeBase(query, wiring, topK),
  };
}
