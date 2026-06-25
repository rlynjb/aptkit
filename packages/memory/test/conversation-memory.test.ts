import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryVectorStore } from '@aptkit/retrieval';
import type { EmbeddingProvider } from '@aptkit/retrieval';
import { createConversationMemory } from '../src/index.js';

// Deterministic fake embedder (dim 4) keyed off keyword presence, so cosine
// ranking is exact and tests can't flake.
const fake: EmbeddingProvider = {
  id: 'fake',
  dimension: 4,
  async embed(texts) {
    return texts.map((t) => {
      const s = t.toLowerCase();
      return [
        s.includes('editor') || s.includes('neovim') ? 1 : 0,
        s.includes('coffee') ? 1 : 0,
        s.includes('deadline') ? 1 : 0,
        1, // bias dim keeps every vector non-zero
      ];
    });
  },
};

describe('createConversationMemory', () => {
  it('remembers an exchange and recalls it from a paraphrased query', async () => {
    const store = new InMemoryVectorStore(4);
    const memory = createConversationMemory({ embedder: fake, store });
    await memory.remember({ conversationId: 'c1', question: 'what editor do I use', answer: 'neovim' });
    await memory.remember({ conversationId: 'c1', question: 'how do I take my coffee', answer: 'black' });

    const hits = await memory.recall('which editor do I prefer', 1);
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /neovim/);
    assert.equal(hits[0].conversationId, 'c1');
  });

  it('recalls only memory rows, not foreign chunks sharing the store', async () => {
    const store = new InMemoryVectorStore(4);
    // a document chunk (no kind tag) sharing the same store
    await store.upsert([{ id: 'doc1#0', vector: [1, 0, 0, 1], meta: { text: 'editor docs' } }]);
    const memory = createConversationMemory({ embedder: fake, store });
    await memory.remember({ conversationId: 'c1', question: 'what editor do I use', answer: 'neovim' });

    const hits = await memory.recall('editor', 5);
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.id.startsWith('memory:')));
    assert.ok(hits.some((h) => /neovim/.test(h.text)));
  });

  it('throws when embedder and store dimensions disagree', () => {
    const store = new InMemoryVectorStore(768);
    assert.throws(() => createConversationMemory({ embedder: fake, store }), /dimension/);
  });

  it('honors a custom format and kind', async () => {
    const store = new InMemoryVectorStore(4);
    const memory = createConversationMemory({
      embedder: fake,
      store,
      kind: 'episode',
      format: (t) => `${t.question} => ${t.answer}`,
    });
    await memory.remember({ conversationId: 'c9', question: 'editor', answer: 'neovim' });
    const hits = await memory.recall('editor', 1);
    assert.equal(hits[0].id, 'episode:c9:0');
    assert.equal(hits[0].text, 'editor => neovim');
  });
});
