import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectProfile } from '../src/index.js';

// Mirror of renderPromptTemplate from @aptkit/prompts (packages/prompts/src/types.ts).
// Inlined so @aptkit/context stays dependency-free (string in / string out, per design C),
// while still proving the injected result remains a renderable template.
function renderPromptTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}

const template = 'System rules.\n{schema}';
const profile = 'I am Rein. I prefer concise answers and TypeScript.';

test('prepends profile at start by default', () => {
  const out = injectProfile(template, profile);
  assert.ok(out.includes(profile), 'profile text should be present');
  assert.ok(
    out.indexOf(profile) < out.indexOf('System rules.'),
    'profile should come before the template body when position is start',
  );
});

test('appends profile at end when position is end', () => {
  const out = injectProfile(template, profile, { position: 'end' });
  assert.ok(out.includes(profile), 'profile text should be present');
  assert.ok(
    out.indexOf(profile) > out.indexOf('System rules.'),
    'profile should come after the template body when position is end',
  );
});

test('heading appears immediately before the profile block', () => {
  const heading = '## About the user';
  const out = injectProfile(template, profile, { heading });
  const hIdx = out.indexOf(heading);
  const pIdx = out.indexOf(profile);
  assert.ok(hIdx !== -1, 'heading should be present');
  assert.ok(hIdx < pIdx, 'heading should precede the profile block');
  // nothing but whitespace between heading and profile
  const between = out.slice(hIdx + heading.length, pIdx);
  assert.match(between, /^\s*$/, 'only whitespace between heading and profile');
});

test('heading appears immediately before the profile block at end', () => {
  const heading = '## About the user';
  const out = injectProfile(template, profile, { position: 'end', heading });
  const hIdx = out.indexOf(heading);
  const pIdx = out.indexOf(profile);
  assert.ok(hIdx < pIdx, 'heading should precede the profile block');
  const between = out.slice(hIdx + heading.length, pIdx);
  assert.match(between, /^\s*$/, 'only whitespace between heading and profile');
});

test('injected result still renders via renderPromptTemplate', () => {
  const out = injectProfile(template, profile, { heading: '## About the user' });
  const rendered = renderPromptTemplate(out, { schema: 'users(id, name)' });
  assert.ok(rendered.includes(profile), 'profile preserved after render');
  assert.ok(rendered.includes('users(id, name)'), 'placeholder substituted');
  assert.ok(!rendered.includes('{schema}'), 'placeholder fully replaced');
});
