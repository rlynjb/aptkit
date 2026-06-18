import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertRequiredPaths,
  evaluateStructuralDiff,
} from '../src/index.js';

const subject = {
  id: 'replay-1',
  score: 10.2,
  answer: 'Revenue in SP decreased after voucher demand dropped.',
  recommendations: [
    { title: 'Campaign', bloomreachFeature: 'campaign', steps: ['Build segment'] },
    { title: 'Scenario', bloomreachFeature: 'scenario', steps: ['Trigger journey'] },
  ],
  anomalies: [
    { category: 'revenue_drop', scope: ['SP', 'voucher'], severity: 'warning' },
  ],
};

describe('structural diff evaluator', () => {
  it('preserves required-path assertions', () => {
    assert.deepEqual(assertRequiredPaths(subject, ['id', 'recommendations.0.title']), {
      ok: true,
      issues: [],
    });
  });

  it('evaluates equality, numeric tolerances, counts, text, and array inclusion', () => {
    const result = evaluateStructuralDiff(subject, [
      { type: 'equals', path: 'id', expected: 'replay-1' },
      { type: 'number', path: 'score', expected: 10, tolerance: 0.25 },
      { type: 'arrayCount', path: 'recommendations', min: 2, max: 3 },
      { type: 'containsText', path: 'answer', text: 'voucher demand' },
      { type: 'arrayIncludes', path: 'recommendations', itemPath: 'bloomreachFeature', value: 'campaign' },
      { type: 'arrayIncludes', path: 'anomalies', itemPath: 'scope', value: 'SP' },
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
  });

  it('reports useful paths for failures', () => {
    const result = evaluateStructuralDiff(subject, [
      { type: 'required', path: 'missing.value' },
      { type: 'equals', path: 'id', expected: 'other' },
      { type: 'number', path: 'score', expected: 20, tolerance: 1 },
      { type: 'arrayCount', path: 'recommendations', exact: 1 },
      { type: 'containsText', path: 'answer', text: 'shipping delay' },
      { type: 'arrayIncludes', path: 'recommendations', itemPath: 'bloomreachFeature', value: 'experiment' },
    ]);

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), [
      'missing.value',
      'id',
      'score',
      'recommendations',
      'answer',
      'recommendations.bloomreachFeature',
    ]);
  });
});
