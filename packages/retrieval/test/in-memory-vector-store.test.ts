import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryVectorStore } from '../src/index.js';

test('upsert then search returns the planted relevant chunk on top by descending cosine score', async () => {
  const store = new InMemoryVectorStore(3);

  await store.upsert([
    { id: 'aligned', vector: [1, 0, 0], meta: { text: 'on target' } },
    { id: 'orthogonal', vector: [0, 1, 0], meta: { text: 'unrelated' } },
    { id: 'opposite', vector: [-1, 0, 0], meta: { text: 'anti' } },
  ]);

  const hits = await store.search([1, 0, 0], 3);

  assert.equal(hits.length, 3);
  assert.equal(hits[0]?.id, 'aligned');
  assert.equal(hits[0]?.meta.text, 'on target');
  // strictly descending cosine score
  assert.ok(hits[0]!.score >= hits[1]!.score);
  assert.ok(hits[1]!.score >= hits[2]!.score);
  assert.ok(Math.abs(hits[0]!.score - 1) < 1e-9);
});

test('search respects k', async () => {
  const store = new InMemoryVectorStore(2);
  await store.upsert([
    { id: 'a', vector: [1, 0], meta: {} },
    { id: 'b', vector: [0, 1], meta: {} },
  ]);
  const hits = await store.search([1, 0], 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, 'a');
});

test('upsert replaces an existing id rather than duplicating it', async () => {
  const store = new InMemoryVectorStore(2);
  await store.upsert([{ id: 'a', vector: [1, 0], meta: { v: 1 } }]);
  await store.upsert([{ id: 'a', vector: [0, 1], meta: { v: 2 } }]);
  const hits = await store.search([0, 1], 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.meta.v, 2);
});

test('upsert throws a dimension-mismatch error for a wrong-length vector', async () => {
  const store = new InMemoryVectorStore(3);
  await assert.rejects(
    () => store.upsert([{ id: 'bad', vector: [1, 0], meta: {} }]),
    /dimension/i,
  );
});

test('search throws a dimension-mismatch error for a wrong-length query vector', async () => {
  const store = new InMemoryVectorStore(3);
  await assert.rejects(() => store.search([1, 0], 1), /dimension/i);
});
