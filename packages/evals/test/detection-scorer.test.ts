import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreDetections } from '../src/index.js';

const detections = [
  {
    category: 'revenue_drop',
    metric: 'revenue',
    scope: ['SP', 'voucher'],
    severity: 'warning',
  },
  {
    category: 'conversion_drop',
    metric: 'conversion_rate',
    scope: ['RJ'],
    severity: 'critical',
  },
];

describe('detection scorer', () => {
  it('scores a full match', () => {
    const result = scoreDetections(detections, {
      minCount: 2,
      requiredCategories: ['revenue_drop'],
      requiredMetrics: ['revenue'],
      requiredScopes: ['SP'],
      requiredSeverities: ['warning'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.score, 1);
    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.matched, ['category:revenue_drop', 'metric:revenue', 'scope:SP', 'severity:warning']);
  });

  it('reports partial matches with issues and a fractional score', () => {
    const result = scoreDetections(detections, {
      minCount: 3,
      requiredCategories: ['revenue_drop', 'inventory_spike'],
      requiredScopes: ['MG'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.score, 0.25);
    assert.deepEqual(result.matched, ['category:revenue_drop']);
    assert.deepEqual(result.missed, ['category:inventory_spike', 'scope:MG']);
    assert.deepEqual(result.issues.map((issue) => issue.path), [
      'expectations.minCount',
      'expectations.requiredCategories',
      'expectations.requiredScopes',
    ]);
  });

  it('tracks unexpected categories when category expectations exist', () => {
    const result = scoreDetections(detections, {
      maxCount: 1,
      requiredCategories: ['revenue_drop'],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.unexpected, ['category:conversion_drop']);
    assert.ok(result.issues.some((issue) => issue.path === 'expectations.maxCount'));
  });
});
