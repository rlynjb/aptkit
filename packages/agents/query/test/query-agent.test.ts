import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityEvent, ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import { classifyIntent, parseIntent, QueryAgent, validateQueryAnswer, type Intent, type WorkspaceDescriptor } from '../src/index.js';
import fixture from '../fixtures/revenue-by-state-query.json' with { type: 'json' };

describe('QueryAgent', () => {
  it('runs with fake providers and returns a grounded prose answer', async () => {
    const model = new ScriptedModelProvider(fixture.modelResponses as ModelResponse[]);
    const tools = toolsFromFixture();
    const events: CapabilityEvent[] = [];
    const agent = new QueryAgent({
      model,
      tools,
      workspace: fixture.workspace as WorkspaceDescriptor,
      trace: { emit: (event) => events.push(event) },
    });

    const answer = await agent.answer(fixture.question, { intent: fixture.intent as Intent });

    assert.match(answer, /BRL 285,500/);
    assert.match(answer, /SP.*RJ.*MG/s);
    assert.equal(model.requests[0]?.tools?.length, 1);
    assert.equal(model.requests[0]?.tools?.[0]?.name, 'get_metric_timeseries');
    assert.deepEqual(events.map((event) => event.type), [
      'model_usage',
      'tool_call_start',
      'tool_call_end',
      'model_usage',
      'step',
    ]);
  });

  it('parses and classifies intent through the model provider seam', async () => {
    assert.equal(parseIntent('recommendation'), 'recommendation');
    assert.equal(parseIntent('what changed? monitoring'), 'monitoring');
    assert.equal(parseIntent('unknown'), 'diagnostic');

    const model = new ScriptedModelProvider([
      { content: [{ type: 'text', text: 'monitoring' }], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    assert.equal(await classifyIntent(model, 'What changed last week?'), 'monitoring');
  });

  it('validates query answers', () => {
    assert.equal(validateQueryAnswer('SP revenue was BRL 285,500 and RJ was BRL 121,000.').ok, true);
    assert.equal(validateQueryAnswer('').ok, false);
    assert.equal(validateQueryAnswer('short').ok, false);
  });
});

function toolsFromFixture() {
  const definitions = fixture.tools.map(({ result: _result, ...definition }) => definition) as ToolDefinition[];
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }
  handlers.unsafe_write = () => {
    throw new Error('should not be called');
  };
  return new InMemoryToolRegistry(
    [
      ...definitions,
      { name: 'unsafe_write', description: 'Should not be advertised', inputSchema: { type: 'object' } },
    ],
    handlers,
  );
}

class ScriptedModelProvider implements ModelProvider {
  readonly id = 'fake';
  readonly defaultModel = 'fake-model';
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error('no scripted model response');
    return response;
  }
}
