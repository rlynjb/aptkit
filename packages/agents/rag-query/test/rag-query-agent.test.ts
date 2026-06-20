import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RagQueryAgent } from '../src/index.js';
import {
  InMemoryVectorStore,
  createRetrievalPipeline,
  createSearchKnowledgeBaseTool,
  type EmbeddingProvider,
  type RetrievalPipeline,
} from '@aptkit/retrieval';
import { InMemoryToolRegistry, type ToolRegistry } from '@aptkit/tools';
import { scorePrecisionAtK } from '@aptkit/evals';
import type {
  CapabilityEvent,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '@aptkit/runtime';

// Deterministic 3-dim embedder (keyword-presence). No live Ollama in unit tests.
const VOCAB = ['paris', 'tokyo', 'berlin'];
class FakeEmbedder implements EmbeddingProvider {
  readonly id = 'fake';
  readonly dimension = 3;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
    });
  }
}

async function buildPipeline(): Promise<RetrievalPipeline> {
  const pipeline = createRetrievalPipeline({
    embedder: new FakeEmbedder(),
    store: new InMemoryVectorStore(3),
  });
  await pipeline.index({
    id: 'paris-doc',
    text: 'Paris is the capital of France. The weather in Paris is mild and pleasant.',
  });
  await pipeline.index({ id: 'tokyo-doc', text: 'Tokyo is the capital of Japan.' });
  return pipeline;
}

function buildRegistry(pipeline: RetrievalPipeline): ToolRegistry {
  const tool = createSearchKnowledgeBaseTool(pipeline);
  return new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });
}

// Stands in for Gemma (package A's contract): emits a tool_use first, then prose.
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly defaultModel = 'scripted';
  calls = 0;
  lastSystem = '';
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.lastSystem = request.system ?? '';
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'search_knowledge_base',
            input: { query: 'weather in Paris' },
          },
        ],
      };
    }
    return { content: [{ type: 'text', text: 'Per the knowledge base, the weather in Paris is mild.' }] };
  }
}

describe('RagQueryAgent', () => {
  it('retrieves via search_knowledge_base, then returns the synthesized answer', async () => {
    const registry = buildRegistry(await buildPipeline());
    const model = new ScriptedProvider();
    const events: CapabilityEvent[] = [];
    const agent = new RagQueryAgent({ model, tools: registry, trace: { emit: (e) => events.push(e) } });

    const answer = await agent.answer('What is the weather in Paris?');

    assert.equal(answer, 'Per the knowledge base, the weather in Paris is mild.');
    const toolStart = events.find((e) => e.type === 'tool_call_start');
    assert.ok(toolStart, 'agent should have called a tool');
    assert.equal((toolStart as { toolName: string }).toolName, 'search_knowledge_base');
  });

  it('injects the user profile into the system prompt (package C)', async () => {
    const registry = buildRegistry(await buildPipeline());
    const model = new ScriptedProvider();
    const agent = new RagQueryAgent({
      model,
      tools: registry,
      profile: 'I prefer terse, data-first answers.',
    });

    await agent.answer('What is the weather in Paris?');

    assert.match(model.lastSystem, /I prefer terse, data-first answers/);
    assert.match(model.lastSystem, /About the person you are assisting/);
  });

  it('measures retrieval quality with precision@k (package D over package B)', async () => {
    const pipeline = await buildPipeline();
    const hits = await pipeline.query('weather in Paris', 2);
    const retrievedDocIds = hits.map((hit) => hit.meta.docId as string);
    const { score } = scorePrecisionAtK(retrievedDocIds, new Set(['paris-doc']), 1);
    assert.equal(score, 1, 'the Paris doc should rank first');
  });
});
