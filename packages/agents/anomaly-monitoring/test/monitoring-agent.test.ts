import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityEvent, ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import { AnomalyMonitoringAgent, coverageReport, ECOMMERCE_ANOMALY_CATEGORIES, schemaCapabilities, validateAnomalies } from '../src/index.js';
import fixture from '../fixtures/sp-revenue-monitoring.json' with { type: 'json' };

describe('AnomalyMonitoringAgent', () => {
  it('runs with fake providers and returns sorted valid anomalies', async () => {
    const model = new ScriptedModelProvider(fixture.modelResponses as ModelResponse[]);
    const tools = toolsFromFixture();
    const events: CapabilityEvent[] = [];
    const agent = new AnomalyMonitoringAgent({
      model,
      tools,
      workspace: fixture.workspace,
      trace: { emit: (event) => events.push(event) },
    });

    const anomalies = await agent.scan();

    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0]?.metric, 'revenue');
    assert.equal(anomalies[0]?.category, 'revenue_drop');
    assert.equal(anomalies[0]?.severity, 'critical');
    assert.equal(model.requests[0]?.tools?.length, 3);
    assert.deepEqual(model.requests[0]?.tools?.map((tool) => tool.name).sort(), [
      'get_anomaly_context',
      'get_metric_timeseries',
      'get_segments',
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

  it('gates categories from workspace capabilities', () => {
    const capabilities = schemaCapabilities(fixture.workspace);
    const report = coverageReport(ECOMMERCE_ANOMALY_CATEGORIES, capabilities);

    assert.equal(report.find((item) => item.category === 'revenue_drop')?.coverage, 'full');
    assert.equal(report.find((item) => item.category === 'conversion_drop')?.coverage, 'full');
    assert.equal(report.find((item) => item.category === 'search_failure')?.coverage, 'unavailable');
  });

  it('validates anomaly output shape', () => {
    const validation = validateAnomalies([
      {
        metric: 'payment_value',
        scope: ['payment_type:voucher'],
        change: { value: 93, direction: 'down', baseline: 'recent vs baseline' },
        severity: 'critical',
        evidence: [],
      },
    ]);

    assert.equal(validation.ok, true);
    assert.equal(validateAnomalies([{ metric: 'x' }]).ok, false);
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
      { name: 'get_segments', description: 'List segments', inputSchema: { type: 'object' } },
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
