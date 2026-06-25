import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryToolRegistry } from '@aptkit/tools';
import { InMemoryVectorStore } from '@aptkit/retrieval';
import type { EmbeddingProvider } from '@aptkit/retrieval';
import { createConversationMemory, createMemoryTool, SEARCH_MEMORY_TOOL_NAME } from '../src/index.js';

const fake: EmbeddingProvider = {
  id: 'fake',
  dimension: 4,
  async embed(texts) {
    return texts.map((t) => {
      const s = t.toLowerCase();
      return [s.includes('editor') || s.includes('neovim') ? 1 : 0, 0, 0, 1];
    });
  },
};

describe('createMemoryTool', () => {
  it('exposes search_memory through a registry and returns recalled memories', async () => {
    const store = new InMemoryVectorStore(4);
    const memory = createConversationMemory({ embedder: fake, store });
    await memory.remember({ conversationId: 'c1', question: 'what editor', answer: 'neovim' });

    const { definition, handler } = createMemoryTool(memory);
    assert.equal(definition.name, SEARCH_MEMORY_TOOL_NAME);

    const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });
    const { result } = await registry.callTool(SEARCH_MEMORY_TOOL_NAME, { query: 'editor' });
    const out = result as { memories: { text: string }[] };
    assert.ok(out.memories.some((m) => /neovim/.test(m.text)));
  });
});
