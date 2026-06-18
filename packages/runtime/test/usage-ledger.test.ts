import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  estimateCost,
  formatCost,
  modelTurnCount,
  pricingForModel,
  summarizeUsage,
  type CapabilityEvent,
} from '../src/index.js';

const trace: CapabilityEvent[] = [
  {
    type: 'model_usage',
    capabilityId: 'agent.test',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 1_000,
    outputTokens: 250,
    timestamp: '2026-06-18T00:00:00.000Z',
  },
  {
    type: 'step',
    capabilityId: 'agent.test',
    role: 'assistant',
    content: 'done',
    timestamp: '2026-06-18T00:00:01.000Z',
  },
  {
    type: 'model_usage',
    capabilityId: 'agent.test',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    outputTokens: 50,
    estimated: true,
    timestamp: '2026-06-18T00:00:02.000Z',
  },
];

describe('usage ledger', () => {
  it('summarizes model usage events and ignores non-usage trace events', () => {
    assert.deepEqual(summarizeUsage(trace), {
      inputTokens: 1_000,
      outputTokens: 300,
      totalTokens: 1_300,
      modelName: 'gpt-4.1-mini',
      turns: 2,
      estimated: true,
    });
    assert.equal(modelTurnCount(trace), 2);
  });

  it('estimates OpenAI costs for known model families', () => {
    const cost = estimateCost('openai', { inputTokens: 1_000_000, outputTokens: 500_000 }, 'gpt-4.1');
    assert.deepEqual(cost, {
      currency: 'USD',
      inputCost: 2,
      outputCost: 4,
      totalCost: 6,
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 8,
      estimated: true,
    });
    assert.deepEqual(pricingForModel('openai', 'gpt-4.1-mini-2025-04-14'), {
      inputUsdPerMillion: 0.4,
      outputUsdPerMillion: 1.6,
    });
  });

  it('does not estimate unknown providers or model families', () => {
    assert.equal(estimateCost('fixture', { inputTokens: 1, outputTokens: 1 }, 'fixture-model'), undefined);
    assert.equal(pricingForModel('openai', 'unknown-model'), undefined);
  });

  it('formats compact cost displays', () => {
    assert.equal(formatCost(undefined), 'n/a');
    assert.equal(formatCost({
      currency: 'USD',
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      estimated: true,
    }), '$0.00');
    assert.equal(formatCost(estimateCost('openai', { inputTokens: 100, outputTokens: 100 }, 'gpt-4.1')), '$0.0010');
  });
});
