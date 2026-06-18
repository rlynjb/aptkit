import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityEvent, ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import { DiagnosticInvestigationAgent, diagnosisConfidence, validateDiagnosis, type Anomaly, type Diagnosis } from '../src/index.js';
import fixture from '../fixtures/sp-revenue-diagnostic.json' with { type: 'json' };

describe('DiagnosticInvestigationAgent', () => {
  it('runs with fake providers and returns a valid diagnosis', async () => {
    const model = new ScriptedModelProvider(fixture.modelResponses as ModelResponse[]);
    const tools = toolsFromFixture();
    const events: CapabilityEvent[] = [];
    const agent = new DiagnosticInvestigationAgent({
      model,
      tools,
      workspace: fixture.workspace,
      trace: { emit: (event) => events.push(event) },
    });

    const diagnosis = await agent.investigate(fixture.anomaly as Anomaly);

    assert.match(diagnosis.conclusion, /SP revenue drop|Sao Paulo/i);
    assert.equal(diagnosis.confidence, 'high');
    assert.equal(diagnosis.hypothesesConsidered.some((hypothesis) => hypothesis.supported), true);
    assert.equal(model.requests[0]?.tools?.length, 2);
    assert.deepEqual(model.requests[0]?.tools?.map((tool) => tool.name).sort(), [
      'get_anomaly_context',
      'get_metric_timeseries',
    ]);
    assert.deepEqual(events.map((event) => event.type), [
      'model_usage',
      'tool_call_start',
      'tool_call_end',
      'model_usage',
      'tool_call_start',
      'tool_call_end',
      'model_usage',
      'step',
    ]);
  });

  it('synthesizes a diagnosis from recovery when first output is not parseable', async () => {
    const validDiagnosis = JSON.stringify({
      conclusion: 'SP decline is isolated to Sao Paulo.',
      evidence: ['SP fell 30% while RJ was flat.'],
      hypothesesConsidered: [
        { hypothesis: 'Sao Paulo issue', supported: true, reasoning: 'SP moved independently from other states.' },
      ],
    });
    const model = new ScriptedModelProvider([
      { content: [{ type: 'text', text: 'I need more queries.' }], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [{ type: 'text', text: `\`\`\`json\n${validDiagnosis}\n\`\`\`` }], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new DiagnosticInvestigationAgent({
      model,
      tools: toolsFromFixture(),
      workspace: fixture.workspace,
    });

    const diagnosis = await agent.investigate(fixture.anomaly as Anomaly);

    assert.match(diagnosis.conclusion, /isolated/);
    assert.equal(model.requests.length, 2);
  });

  it('validates diagnosis output shape and derives confidence', () => {
    const diagnosis: Diagnosis = {
      conclusion: 'Payment-value drop is isolated to voucher orders.',
      evidence: ['Voucher payment fell 93%.'],
      hypothesesConsidered: [
        { hypothesis: 'Voucher outage', supported: true, reasoning: 'Voucher orders dropped while boleto was flat.' },
        { hypothesis: 'Broad demand change', supported: false, reasoning: 'Other payment types did not drop.' },
      ],
    };

    assert.equal(validateDiagnosis(diagnosis).ok, true);
    assert.equal(validateDiagnosis({ conclusion: 'missing fields' }).ok, false);
    assert.equal(diagnosisConfidence(diagnosis), 'high');
    assert.equal(diagnosisConfidence({ ...diagnosis, hypothesesConsidered: [] }), 'low');
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
