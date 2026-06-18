import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queryPromptPackage, renderPromptTemplate } from '../src/index.js';

describe('prompt packages', () => {
  it('exposes query prompt metadata and required variables', () => {
    assert.equal(queryPromptPackage.capabilityId, 'query-agent');
    assert.match(queryPromptPackage.system, /Answer the user's free-form question/);
    assert.deepEqual(
      queryPromptPackage.variables.map((variable) => variable.name).sort(),
      ['intent', 'project_id', 'schema'],
    );
  });

  it('renders known variables without removing unknown placeholders', () => {
    const rendered = renderPromptTemplate(
      'Project {project_id}: {schema}. Unknown {later}.',
      { project_id: 'olist', schema: 'purchase events' },
    );

    assert.equal(rendered, 'Project olist: purchase events. Unknown {later}.');
  });
});
