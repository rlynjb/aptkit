import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coverageReport,
  missingCapabilities,
  requirementCoverage,
  runnableRequirements,
  schemaCapabilities,
  type CoverageRequirement,
} from '../src/index.js';

const requirements: CoverageRequirement[] = [
  { id: 'revenue_drop', label: 'revenue drop', requires: ['purchase'] },
  { id: 'inventory', label: 'inventory', requires: ['purchase'], enriches: ['catalog:inventory_level'] },
  { id: 'search_failure', label: 'search failure', requires: ['search'] },
];

describe('coverage gate', () => {
  it('builds capability tokens from events, event properties, and catalogs', () => {
    const capabilities = schemaCapabilities({
      events: [{ name: 'purchase', properties: ['total_price'] }],
      catalogs: [{ name: 'inventory_level' }],
    });

    assert.equal(capabilities.has('purchase'), true);
    assert.equal(capabilities.has('purchase.total_price'), true);
    assert.equal(capabilities.has('catalog:inventory_level'), true);
  });

  it('classifies full, limited, and unavailable requirements', () => {
    const capabilities = new Set(['purchase']);

    assert.equal(requirementCoverage(requirements[0], capabilities), 'full');
    assert.equal(requirementCoverage(requirements[1], capabilities), 'limited');
    assert.equal(requirementCoverage(requirements[2], capabilities), 'unavailable');
    assert.deepEqual(missingCapabilities(requirements[1], capabilities), ['catalog:inventory_level']);
  });

  it('reports coverage and filters runnable requirements', () => {
    const capabilities = new Set(['purchase']);

    assert.deepEqual(coverageReport(requirements, capabilities), [
      { category: 'revenue_drop', label: 'revenue drop', coverage: 'full' },
      { category: 'inventory', label: 'inventory', coverage: 'limited', missing: ['catalog:inventory_level'] },
      { category: 'search_failure', label: 'search failure', coverage: 'unavailable', missing: ['search'] },
    ]);
    assert.deepEqual(runnableRequirements(requirements, capabilities).map((item) => item.id), ['revenue_drop', 'inventory']);
  });
});
