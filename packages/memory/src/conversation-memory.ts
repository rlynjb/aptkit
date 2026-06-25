import type { EmbeddingProvider, VectorStore, VectorHit } from '@aptkit/retrieval';

/** One conversational exchange to remember. */
export type MemoryTurn = {
  conversationId: string;
  question: string;
  answer: string;
};

/** A recalled past exchange, ranked by similarity to the recall query. */
export type MemoryHit = {
  id: string;
  score: number;
  text: string;
  conversationId?: string;
};

export type ConversationMemoryOptions = {
  embedder: EmbeddingProvider;
  /**
   * Where memory vectors live. May be the SAME store the documents use (memory
   * is then mixed into the corpus and surfaces via the document search tool) or
   * a DEDICATED store (memory isolated). The caller decides; this module does
   * not care which — it only speaks the VectorStore contract.
   */
  store: VectorStore;
  /** How an exchange is rendered into embeddable/recallable text. */
  format?: (turn: MemoryTurn) => string;
  /** Metadata tag + id namespace marking these rows as memory. Default 'memory'. */
  kind?: string;
};

/** Long-term, retrieval-based episodic memory: store exchanges, recall by similarity. */
export type ConversationMemory = {
  /** Embed an exchange and store it as a memory row. */
  remember(turn: MemoryTurn): Promise<void>;
  /** Recall the past exchanges most relevant to `query` (memory rows only). */
  recall(query: string, k?: number): Promise<MemoryHit[]>;
};

const DEFAULT_KIND = 'memory';
const DEFAULT_RECALL_K = 5;

function defaultFormat(turn: MemoryTurn): string {
  return `Past exchange — user asked: "${turn.question}"\nassistant answered: "${turn.answer}"`;
}

/**
 * Builds an episodic conversation memory over an embedder + vector store.
 *
 * `remember` embeds the formatted exchange and upserts it tagged `kind` so it is
 * distinguishable from documents. `recall` embeds the query, searches, and keeps
 * only rows of this `kind` — so recall works even when memory shares a store with
 * documents (the VectorStore contract has no metadata filter, so recall over-
 * fetches then filters).
 *
 * The store is injected: the engine never names a database. Pass a `PgVectorStore`
 * for durable memory, an `InMemoryVectorStore` for tests — the logic is identical.
 */
export function createConversationMemory(opts: ConversationMemoryOptions): ConversationMemory {
  const { embedder, store } = opts;
  if (embedder.dimension !== store.dimension) {
    throw new Error(
      `embedder dimension ${embedder.dimension} != store dimension ${store.dimension}`,
    );
  }
  const kind = opts.kind ?? DEFAULT_KIND;
  const format = opts.format ?? defaultFormat;
  // Per-conversation counters so repeated turns get distinct ids. conversationId
  // is assumed unique per conversation, so ids never collide across conversations.
  const counters = new Map<string, number>();

  return {
    async remember(turn: MemoryTurn): Promise<void> {
      const text = format(turn);
      const [vector] = await embedder.embed([text]);
      if (!vector) return;
      const n = counters.get(turn.conversationId) ?? 0;
      counters.set(turn.conversationId, n + 1);
      await store.upsert([
        {
          id: `${kind}:${turn.conversationId}:${n}`,
          vector,
          meta: { kind, conversationId: turn.conversationId, text },
        },
      ]);
    },

    async recall(query: string, k: number = DEFAULT_RECALL_K): Promise<MemoryHit[]> {
      const [vector] = await embedder.embed([query]);
      if (!vector) return [];
      // Over-fetch then filter: a shared store may return documents above memory,
      // and search itself cannot filter by metadata.
      const fetchK = Math.max(k * 4, 20);
      const hits = await store.search(vector, fetchK);
      return hits
        .filter((h: VectorHit) => h.meta?.kind === kind)
        .slice(0, k)
        .map((h: VectorHit) => ({
          id: h.id,
          score: h.score,
          text: typeof h.meta?.text === 'string' ? h.meta.text : '',
          conversationId:
            typeof h.meta?.conversationId === 'string' ? h.meta.conversationId : undefined,
        }));
    },
  };
}
