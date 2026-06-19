import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANOMALY_MONITORING_CAPABILITY_ID,
  AnomalyMonitoringAgent,
  DEFAULT_ACTION_TAXONOMY,
  DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID,
  DiagnosticInvestigationAgent,
  FixtureModelProvider,
  InMemoryToolRegistry,
  QUERY_CAPABILITY_ID,
  QueryAgent,
  RecommendationAgent,
  RUBRIC_IMPROVEMENT_CAPABILITY_ID,
  RubricJudge,
  RubricImprovementAgent,
  anomalyMonitoringToolPolicy,
  diagnosticInvestigationToolPolicy,
  ensureGeneratedContent,
  generateStructured,
  parseIntent,
  recommendationPromptPackage,
  recommendationToolPolicy,
  queryToolPolicy,
  rubricImprovementToolPolicy,
  schemaSummary,
  splitMarkdownSections,
} from '../src/index.js';

describe('@aptkit/core', () => {
  it('re-exports the recommendation slice entry points', () => {
    assert.equal(typeof RecommendationAgent, 'function');
    assert.equal(typeof FixtureModelProvider, 'function');
    assert.equal(typeof InMemoryToolRegistry, 'function');
    assert.equal(typeof schemaSummary, 'function');
    assert.equal(typeof generateStructured, 'function');
    assert.equal(typeof RubricJudge, 'function');
    assert.equal(typeof ensureGeneratedContent, 'function');
    assert.equal(typeof splitMarkdownSections, 'function');
    assert.equal(recommendationToolPolicy.capabilityId, 'recommendation-agent');
    assert.equal(recommendationPromptPackage.capabilityId, 'recommendation-agent');
    assert.ok(DEFAULT_ACTION_TAXONOMY.features.length > 0);
  });

  it('re-exports the remaining Blooming agent entry points', () => {
    assert.equal(typeof AnomalyMonitoringAgent, 'function');
    assert.equal(typeof DiagnosticInvestigationAgent, 'function');
    assert.equal(typeof QueryAgent, 'function');
    assert.equal(typeof RubricImprovementAgent, 'function');
    assert.equal(typeof parseIntent, 'function');
    assert.equal(ANOMALY_MONITORING_CAPABILITY_ID, 'anomaly-monitoring-agent');
    assert.equal(DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID, 'diagnostic-investigation-agent');
    assert.equal(QUERY_CAPABILITY_ID, 'query-agent');
    assert.equal(RUBRIC_IMPROVEMENT_CAPABILITY_ID, 'rubric-improvement-agent');
    assert.equal(anomalyMonitoringToolPolicy.capabilityId, 'anomaly-monitoring-agent');
    assert.equal(diagnosticInvestigationToolPolicy.capabilityId, 'diagnostic-investigation-agent');
    assert.equal(queryToolPolicy.capabilityId, 'query-agent');
    assert.equal(rubricImprovementToolPolicy.capabilityId, 'rubric-improvement-agent');
    assert.equal(parseIntent('recommendation'), 'recommendation');
  });
});
