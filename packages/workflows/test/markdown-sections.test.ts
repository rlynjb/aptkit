import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitMarkdownSections } from '../src/index.js';

describe('splitMarkdownSections', () => {
  it('returns no sections for blank markdown', () => {
    assert.deepEqual(splitMarkdownSections(''), []);
    assert.deepEqual(splitMarkdownSections('   \n  '), []);
  });

  it('returns one unheaded section when no h2 headers exist', () => {
    const sections = splitMarkdownSections('intro paragraph\n\nanother line');
    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.heading, undefined);
    assert.match(sections[0]?.content ?? '', /intro paragraph/);
    assert.match(sections[0]?.content ?? '', /another line/);
  });

  it('starts a new section for each h2 in source order and preserves preamble', () => {
    const sections = splitMarkdownSections([
      'preamble',
      '',
      '## Alpha',
      'alpha body',
      '',
      '## Beta',
      'beta body',
    ].join('\n'));

    assert.equal(sections.length, 3);
    assert.equal(sections[0]?.heading, undefined);
    assert.match(sections[0]?.content ?? '', /preamble/);
    assert.equal(sections[1]?.heading, 'Alpha');
    assert.match(sections[1]?.content ?? '', /alpha body/);
    assert.equal(sections[2]?.heading, 'Beta');
  });

  it('keeps h3 and deeper headings inside the current section', () => {
    const sections = splitMarkdownSections('## Outer\nouter body\n\n### Nested\nnested body');

    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.heading, 'Outer');
    assert.match(sections[0]?.content ?? '', /### Nested/);
    assert.match(sections[0]?.content ?? '', /nested body/);
  });

  it('emits sections for h2 headings with empty bodies', () => {
    const sections = splitMarkdownSections('## First\n## Second');

    assert.equal(sections.length, 2);
    assert.deepEqual(sections.map((section) => section.heading), ['First', 'Second']);
  });
});
