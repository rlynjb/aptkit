import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectNdjsonStream,
  decodeCapabilityEventLines,
  decodeNdjsonLines,
  decodeNdjsonStream,
  encodeCapabilityEvent,
  encodeNdjsonRecord,
  isCapabilityEvent,
  type CapabilityEvent,
} from '../src/index.js';

const event: CapabilityEvent = {
  type: 'step',
  capabilityId: 'agent.test',
  role: 'assistant',
  content: 'ran a step',
  timestamp: '2026-06-18T00:00:00.000Z',
};

async function* chunks(parts: (string | Uint8Array)[]) {
  for (const part of parts) yield part;
}

test('encodes and decodes capability events', () => {
  const encoded = encodeCapabilityEvent(event);
  assert.equal(encoded.endsWith('\n'), true);

  const decoded = decodeCapabilityEventLines(encoded);
  assert.deepEqual(decoded.values, [event]);
  assert.deepEqual(decoded.warnings, []);
  assert.equal(isCapabilityEvent(decoded.values[0]), true);
});

test('keeps malformed lines as bounded warnings', () => {
  const payload = [
    encodeNdjsonRecord({ ok: 1 }).trimEnd(),
    '{nope',
    encodeNdjsonRecord({ ok: 2 }).trimEnd(),
    'still-not-json',
  ].join('\n');

  const decoded = decodeNdjsonLines(payload, { maxWarnings: 1 });
  assert.deepEqual(decoded.values, [{ ok: 1 }, { ok: 2 }]);
  assert.equal(decoded.warnings.length, 1);
  assert.equal(decoded.warnings[0]?.type, 'malformed_line');
  assert.equal(decoded.warnings[0]?.line, 2);
});

test('treats failed validation as malformed records', () => {
  const decoded = decodeCapabilityEventLines(encodeNdjsonRecord({ type: 'step' }));
  assert.deepEqual(decoded.values, []);
  assert.equal(decoded.warnings.length, 1);
  assert.equal(decoded.warnings[0]?.error, 'record failed validation');
});

test('decodes async chunks with partial records', async () => {
  const first = encodeNdjsonRecord({ id: 1 });
  const second = encodeNdjsonRecord({ id: 2 });

  const decoded = await collectNdjsonStream(chunks([first.slice(0, 5), first.slice(5) + second]));
  assert.deepEqual(decoded.values, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(decoded.warnings, []);
});

test('decodes Uint8Array chunks', async () => {
  const bytes = new TextEncoder().encode(encodeNdjsonRecord({ id: 'bytes' }));
  const decoded = await collectNdjsonStream(chunks([bytes]));
  assert.deepEqual(decoded.values, [{ id: 'bytes' }]);
});

test('honors abort signals during stream decoding', async () => {
  const controller = new AbortController();
  const iterator = decodeNdjsonStream(chunks([encodeNdjsonRecord({ id: 1 })]), {
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(() => iterator.next(), /aborted/i);
});
