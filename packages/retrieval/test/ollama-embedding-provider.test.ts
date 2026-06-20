import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OllamaEmbeddingProvider, type EmbedTransport } from '../src/index.js';

test('has the nomic id and 768 dimension', () => {
  const provider = new OllamaEmbeddingProvider();
  assert.equal(provider.id, 'nomic-embed-text');
  assert.equal(provider.dimension, 768);
});

test('embed uses the injected transport, one vector per input text', async () => {
  const seen: { model: string; texts: string[] }[] = [];
  const embed: EmbedTransport = async (payload) => {
    seen.push({ model: payload.model, texts: payload.texts });
    return payload.texts.map((_, i) => [i, i + 1, i + 2]);
  };
  const provider = new OllamaEmbeddingProvider({ embed });

  const vectors = await provider.embed(['alpha', 'beta']);

  assert.equal(vectors.length, 2);
  assert.deepEqual(vectors[0], [0, 1, 2]);
  assert.deepEqual(vectors[1], [1, 2, 3]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.model, 'nomic-embed-text');
  assert.deepEqual(seen[0]?.texts, ['alpha', 'beta']);
});

test('embed forwards an abort signal to the transport', async () => {
  const controller = new AbortController();
  controller.abort();
  const embed: EmbedTransport = async (payload) => {
    payload.signal?.throwIfAborted();
    return [];
  };
  const provider = new OllamaEmbeddingProvider({ embed });
  await assert.rejects(() => provider.embed(['x'], { signal: controller.signal }));
});
