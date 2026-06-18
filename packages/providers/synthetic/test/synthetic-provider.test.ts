import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelProvider, ModelRequest } from '@aptkit/runtime';
import {
  FixtureSyntheticEcommerceDataSource,
  OpenAISyntheticEcommerceDataSource,
  SyntheticEcommerceToolRegistry,
} from '../src/index.js';

describe('synthetic ecommerce provider', () => {
  it('serves deterministic fixture data through the tool registry', async () => {
    const dataSource = new FixtureSyntheticEcommerceDataSource();
    const registry = new SyntheticEcommerceToolRegistry({ dataSource });

    assert.deepEqual(registry.listTools().map((tool) => tool.name), [
      'get_project_overview',
      'get_metric_timeseries',
      'get_anomaly_context',
    ]);

    const timeseries = await registry.callTool('get_metric_timeseries', {
      metric: 'revenue',
      dimension: 'state',
      segment: 'SP',
    });

    assert.equal((timeseries.result as { periodComparison: { pctChange: number } }).periodComparison.pctChange, -0.300245);
  });

  it('uses a model provider for OpenAI-style synthetic JSON', async () => {
    const model = new JsonModelProvider({
      provider: { id: 'synthetic-ecommerce', mode: 'openai', scenarioId: 'custom' },
      periodComparison: {
        metric: 'revenue',
        dimension: 'state',
        segment: 'SP',
        recentWindow: { from: '2026-05-01', to: '2026-06-01' },
        baselineWindow: { from: '2026-02-01', to: '2026-05-01' },
        recentValue: 10,
        baselineAverage: 20,
        pctChange: -0.5,
        relatedSegments: [{ name: 'RJ', pctChange: 0.01 }],
      },
      points: [{ ts: '2026-05-01', segment: 'SP', value: 10 }],
      totalCount: 1,
    });
    const dataSource = new OpenAISyntheticEcommerceDataSource({ model, scenarioId: 'custom' });

    const result = await dataSource.getMetricTimeseries({ metric: 'revenue' });

    assert.equal(result.provider.mode, 'openai');
    assert.equal(result.periodComparison.pctChange, -0.5);
    assert.equal(model.requests[0]?.messages[0]?.role, 'user');
  });
});

class JsonModelProvider implements ModelProvider {
  readonly id = 'json-model';
  readonly requests: ModelRequest[] = [];

  constructor(private readonly response: unknown) {}

  async complete(request: ModelRequest) {
    this.requests.push(request);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(this.response) }],
      model: 'json-fixture',
    };
  }
}
