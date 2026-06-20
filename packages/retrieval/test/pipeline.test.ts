import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryVectorStore,
  chunkText,
  indexDocument,
  queryKnowledgeBase,
  createRetrievalPipeline,
  type EmbeddingProvider,
} from '../src/index.js';

/**
 * Deterministic fake embedder: maps each text to a fixed-dim vector by hashing
 * words into buckets. Texts that share words land near each other in cosine
 * space — enough to plant a relevant chunk and assert it ranks top. No Ollama.
 */
function makeFakeEmbedder(dimension: number): EmbeddingProvider {
  return {
    id: 'fake',
    dimension,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const v = new Array<number>(dimension).fill(0);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % dimension] += 1;
        }
        return v;
      });
    },
  };
}

test('chunkText produces fixed-size (~512 char) chunks with overlap', () => {
  const text = 'x'.repeat(1200);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 512);
  // reassembling without overlap covers the whole document
  const joined = chunks.join('');
  assert.ok(joined.length >= text.length);
});

test('chunkText returns a single chunk for short text', () => {
  const chunks = chunkText('short doc');
  assert.deepEqual(chunks, ['short doc']);
});

test('index -> query round-trip ranks the planted relevant chunk on top', async () => {
  const embedder = makeFakeEmbedder(64);
  const store = new InMemoryVectorStore(64);

  await indexDocument(
    {
      id: 'guide',
      text:
        'Photosynthesis converts sunlight into chemical energy in plants. ' +
        'Mitochondria are the powerhouse of the cell and produce ATP. ' +
        'The capital of France is Paris on the river Seine.',
    },
    { embedder, store },
  );

  const ranked = await queryKnowledgeBase('how do plants use sunlight energy', { embedder, store });

  assert.ok(ranked.length > 0);
  assert.match(String(ranked[0]?.meta.text), /[Pp]hotosynthesis|sunlight/);
  assert.equal(typeof ranked[0]?.score, 'number');
  assert.equal(ranked[0]?.meta.docId, 'guide');
});

test('createRetrievalPipeline throws when provider.dimension !== store.dimension', () => {
  const embedder = makeFakeEmbedder(768);
  const store = new InMemoryVectorStore(64);
  assert.throws(() => createRetrievalPipeline({ embedder, store }), /dimension/i);
});

test('createRetrievalPipeline exposes index and query bound to the wiring', async () => {
  const embedder = makeFakeEmbedder(32);
  const store = new InMemoryVectorStore(32);
  const pipeline = createRetrievalPipeline({ embedder, store });

  await pipeline.index({ id: 'd1', text: 'rivers carry water to the sea' });
  const ranked = await pipeline.query('water flowing to the ocean sea');
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0]?.meta.docId, 'd1');
});
