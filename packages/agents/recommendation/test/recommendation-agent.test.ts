import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAgentJson, type CapabilityEvent, type ModelProvider, type ModelRequest, type ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry } from '@aptkit/tools';
import { RecommendationAgent } from '../src/recommendation-agent.js';
import type { Anomaly, Diagnosis, WorkspaceDescriptor } from '../src/types.js';

const workspace: WorkspaceDescriptor = {
  projectId: 'demo-project',
  projectName: 'Demo Ecommerce',
  events: [
    { name: 'purchase', properties: ['revenue', 'category', 'state'], eventCount: 1200 },
    { name: 'cart_abandoned', properties: ['cart_value', 'device'], eventCount: 840 },
  ],
  customerProperties: ['state', 'email_opt_in'],
  catalogs: [{ id: 'products', name: 'Products' }],
  totalCustomers: 5000,
  totalEvents: 25000,
  oldestTimestamp: Date.parse('2025-01-01T00:00:00Z'),
};

const anomaly: Anomaly = {
  metric: 'mobile_checkout_conversion',
  scope: ['mobile', 'checkout'],
  change: { value: 18, direction: 'down', baseline: 'previous 7 days' },
  severity: 'critical',
  evidence: [{ tool: 'get_metric_timeseries', result: { current: 0.12, prior: 0.146 } }],
};

const diagnosis: Diagnosis = {
  conclusion: 'Mobile checkout conversion fell after a payment step regression.',
  evidence: ['Revenue dropped by 18000 USD', 'Purchase count dropped by 120 orders'],
  hypothesesConsidered: [
    { hypothesis: 'Payment issue', supported: true, reasoning: 'The drop starts at checkout payment.' },
  ],
  affectedCustomers: { count: 340, segmentDescription: 'mobile checkout abandoners' },
  confidence: 'high',
};

describe('RecommendationAgent', () => {
  it('runs with fake providers and assigns ids after validating id-less recommendations', async () => {
    const model = new ScriptedModelProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'list_scenarios',
            input: { project_id: 'demo-project' },
          },
        ],
        usage: { inputTokens: 100, outputTokens: 20 },
        model: 'fake-model',
      },
      {
        content: [
          {
            type: 'text',
            text: '```json\n' + JSON.stringify([
              {
                title: 'Send recovery flow to mobile checkout abandoners',
                rationale: 'The diagnosis shows a payment-step regression affecting mobile shoppers.',
                bloomreachFeature: 'scenario',
                steps: ['Create a mobile checkout abandoner segment', 'Send a recovery email with support copy'],
                estimatedImpact: {
                  range: '+$6k - $10k recovered this week',
                  rangeUsd: { low: 6000, high: 10000 },
                  assumption: 'assumes 15-25% recovery of 340 affected shoppers at observed AOV',
                },
                effort: 'low',
                timeToSetUpMinutes: 30,
                readResultInDays: 7,
                prerequisites: [{ label: 'email channel active', satisfied: true }],
                successMetric: 'mobile checkout recovery purchases from 0 to 50 in 7 days',
                confidence: 'high',
              },
            ]) + '\n```',
          },
        ],
        usage: { inputTokens: 120, outputTokens: 80 },
        model: 'fake-model',
      },
    ]);

    const tools = new InMemoryToolRegistry(
      [
        { name: 'list_scenarios', description: 'List scenarios', inputSchema: { type: 'object' } },
        { name: 'unsafe_write_campaign', description: 'Should not be advertised', inputSchema: { type: 'object' } },
      ],
      {
        list_scenarios: () => ({ data: [] }),
        unsafe_write_campaign: () => {
          throw new Error('should not be called');
        },
      },
    );
    const events: CapabilityEvent[] = [];
    const agent = new RecommendationAgent({
      model,
      tools,
      workspace,
      trace: { emit: (event) => events.push(event) },
      idGenerator: () => 'rec-1',
    });

    const recommendations = await agent.propose(anomaly, diagnosis);

    assert.equal(recommendations.length, 1);
    assert.equal(recommendations[0]?.id, 'rec-1');
    assert.equal(recommendations[0]?.bloomreachFeature, 'scenario');
    assert.equal(model.requests[0]?.tools?.length, 1);
    assert.equal(model.requests[0]?.tools?.[0]?.name, 'list_scenarios');
    assert.deepEqual(events.map((event) => event.type), [
      'model_usage',
      'tool_call_start',
      'tool_call_end',
      'model_usage',
      'step',
    ]);
  });

  it('parses json from prose-wrapped model output', () => {
    assert.deepEqual(parseAgentJson('Result:\n```json\n[{"ok":true}]\n```'), [{ ok: true }]);
    assert.deepEqual(parseAgentJson('prefix {"ok": true} suffix'), { ok: true });
  });
});

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
