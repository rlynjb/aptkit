import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ACTION_TAXONOMY,
  FixtureModelProvider,
  InMemoryToolRegistry,
  RecommendationAgent,
  recommendationPromptPackage,
  recommendationToolPolicy,
  schemaSummary,
} from '../src/index.js';

describe('@aptkit/core', () => {
  it('re-exports the recommendation slice entry points', () => {
    assert.equal(typeof RecommendationAgent, 'function');
    assert.equal(typeof FixtureModelProvider, 'function');
    assert.equal(typeof InMemoryToolRegistry, 'function');
    assert.equal(typeof schemaSummary, 'function');
    assert.equal(recommendationToolPolicy.capabilityId, 'recommendation-agent');
    assert.equal(recommendationPromptPackage.capabilityId, 'recommendation-agent');
    assert.ok(DEFAULT_ACTION_TAXONOMY.features.length > 0);
  });
});
