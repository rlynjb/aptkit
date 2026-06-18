import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diagnosticPromptPackage,
  monitoringPromptPackage,
  queryPromptPackage,
  recommendationPromptPackage,
  renderPromptTemplate,
  type PromptPackage,
} from '../src/index.js';

const variableNames = (promptPackage: PromptPackage): string[] =>
  promptPackage.variables.map((variable) => variable.name).sort();

describe('prompt packages', () => {
  it('exposes query prompt metadata and required variables', () => {
    assert.equal(queryPromptPackage.capabilityId, 'query-agent');
    assert.match(queryPromptPackage.system, /Answer the user's free-form question/);
    assert.deepEqual(variableNames(queryPromptPackage), ['intent', 'project_id', 'schema']);
  });

  it('exposes diagnostic prompt metadata and required variables', () => {
    assert.equal(diagnosticPromptPackage.capabilityId, 'diagnostic-investigation-agent');
    assert.match(diagnosticPromptPackage.system, /investigate why one specific anomaly occurred/);
    assert.deepEqual(variableNames(diagnosticPromptPackage), ['anomaly', 'project_id', 'schema']);
  });

  it('exposes monitoring prompt metadata and required variables', () => {
    assert.equal(monitoringPromptPackage.capabilityId, 'anomaly-monitoring-agent');
    assert.match(monitoringPromptPackage.system, /detect measurable anomalies only/);
    assert.deepEqual(variableNames(monitoringPromptPackage), ['categories', 'schema']);
  });

  it('exposes recommendation prompt metadata and required variables', () => {
    assert.equal(recommendationPromptPackage.capabilityId, 'recommendation-agent');
    assert.match(recommendationPromptPackage.system, /propose 2-3 concrete actions/);
    assert.deepEqual(variableNames(recommendationPromptPackage), ['diagnosis', 'project_id', 'schema']);
  });

  it('renders known variables without removing unknown placeholders', () => {
    const rendered = renderPromptTemplate(
      'Project {project_id}: {schema}. Unknown {later}.',
      { project_id: 'olist', schema: 'purchase events' },
    );

    assert.equal(rendered, 'Project olist: purchase events. Unknown {later}.');
  });
});
