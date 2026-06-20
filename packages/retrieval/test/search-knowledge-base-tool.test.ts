import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryToolRegistry, filterToolsForPolicy } from '@aptkit/tools';

import {
  InMemoryVectorStore,
  createRetrievalPipeline,
  createSearchKnowledgeBaseTool,
  SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
  type EmbeddingProvider,
} from '../src/index.js';

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

async function seededPipeline() {
  const embedder = makeFakeEmbedder(64);
  const store = new InMemoryVectorStore(64);
  const pipeline = createRetrievalPipeline({ embedder, store });
  await pipeline.index({ id: 'space', text: 'The moon orbits the earth once every month.' });
  await pipeline.index({ id: 'cooking', text: 'Garlic and onions form the base of many sauces.' });
  return pipeline;
}

test('tool registers into InMemoryToolRegistry and returns durationMs', async () => {
  const pipeline = await seededPipeline();
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);

  const registry = new InMemoryToolRegistry([definition], {
    [definition.name]: handler,
  });

  const { result, durationMs } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'how often does the moon orbit earth',
  });

  assert.equal(typeof durationMs, 'number');
  assert.ok(durationMs >= 0);

  const payload = result as { results: { id: string; score: number; citation: string }[] };
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.length > 0);
  assert.equal(payload.results[0]?.id, 'space#0');
  assert.equal(typeof payload.results[0]?.score, 'number');
  assert.ok(payload.results[0]?.citation);
});

test('tool honors top_k', async () => {
  const pipeline = await seededPipeline();
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
  const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });

  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'anything',
    top_k: 1,
  });
  const payload = result as { results: unknown[] };
  assert.equal(payload.results.length, 1);
});

test('tool floors top_k to minTopK so a weak model cannot starve retrieval', async () => {
  const pipeline = await seededPipeline(); // 2 chunks indexed
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline, { minTopK: 2 });
  const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });

  // Model under-fetches with top_k: 1; the floor lifts it back to 2.
  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'anything',
    top_k: 1,
  });
  const payload = result as { results: unknown[] };
  assert.equal(payload.results.length, 2);
});

test('tool honors a meta filter', async () => {
  const pipeline = await seededPipeline();
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
  const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });

  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'anything',
    filter: { docId: 'cooking' },
  });
  const payload = result as { results: { meta: { docId: string } }[] };
  assert.ok(payload.results.length > 0);
  for (const r of payload.results) assert.equal(r.meta.docId, 'cooking');
});

test('ignores filter keys absent from chunk metadata (a hallucinated filter does not wipe results)', async () => {
  const pipeline = await seededPipeline();
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
  const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });

  // A weak model invents a filter key no chunk carries. It must not zero out retrieval.
  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'how often does the moon orbit earth',
    filter: { textContains: 'moon' },
  });
  const payload = result as { results: unknown[] };
  assert.ok(payload.results.length > 0, 'hallucinated filter key should be ignored, not exclude everything');
});

test('tool is selectable via filterToolsForPolicy', async () => {
  const pipeline = await seededPipeline();
  const { definition } = createSearchKnowledgeBaseTool(pipeline);

  const selected = filterToolsForPolicy([definition], {
    capabilityId: 'rag',
    allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.name, SEARCH_KNOWLEDGE_BASE_TOOL_NAME);
  assert.ok(selected[0]?.inputSchema);

  const excluded = filterToolsForPolicy([definition], {
    capabilityId: 'none',
    allowedTools: [],
  });
  assert.equal(excluded.length, 0);
});
