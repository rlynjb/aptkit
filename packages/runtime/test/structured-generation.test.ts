import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateStructured,
  type CapabilityEvent,
  type JsonValidation,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '../src/index.js';

type NamedValue = { name: string };

function validateNamedValue(value: unknown): JsonValidation<NamedValue> {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { name?: unknown }).name === 'string'
  ) {
    return { ok: true, value: { name: (value as { name: string }).name } };
  }
  return { ok: false, error: 'expected object with string name' };
}

class ScriptedProvider implements ModelProvider {
  readonly id = 'fixture';
  readonly defaultModel = 'fixture-model';
  readonly requests: ModelRequest[] = [];
  private readonly responses: Array<ModelResponse | Error>;

  constructor(responses: Array<ModelResponse | Error>) {
    this.responses = responses;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    request.signal?.throwIfAborted();
    const next = this.responses.shift();
    if (!next) throw new Error('no scripted response');
    if (next instanceof Error) throw next;
    return next;
  }
}

function textResponse(text: string, usage = { inputTokens: 1, outputTokens: 2 }): ModelResponse {
  return {
    content: [{ type: 'text', text }],
    usage,
    model: 'fixture-model',
  };
}

describe('generateStructured', () => {
  it('returns typed output from valid JSON on the first attempt', async () => {
    const trace: CapabilityEvent[] = [];
    const model = new ScriptedProvider([textResponse('{"name":"Ada"}')]);

    const result = await generateStructured({
      capabilityId: 'structured.test',
      model,
      userPrompt: 'Return a name.',
      validate: validateNamedValue,
      trace: { emit: (event) => trace.push(event) },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, { name: 'Ada' });
    assert.equal(result.attempts.length, 1);
    assert.equal(trace.filter((event) => event.type === 'model_usage').length, 1);
  });

  it('extracts fenced or prose-wrapped JSON using the shared parser', async () => {
    const model = new ScriptedProvider([
      textResponse('Here is the object:\n```json\n{"name":"Grace"}\n```'),
    ]);

    const result = await generateStructured({
      capabilityId: 'structured.test',
      model,
      userPrompt: 'Return a name.',
      validate: validateNamedValue,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, { name: 'Grace' });
  });

  it('retries with a strict JSON suffix after parse or validation failure', async () => {
    const trace: CapabilityEvent[] = [];
    const model = new ScriptedProvider([
      textResponse('not json'),
      textResponse('{"name":"Katherine"}'),
    ]);

    const result = await generateStructured({
      capabilityId: 'structured.test',
      model,
      userPrompt: 'Return a name.',
      validate: validateNamedValue,
      trace: { emit: (event) => trace.push(event) },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, { name: 'Katherine' });
    assert.equal(result.attempts.length, 2);
    assert.match(String(model.requests[1]?.messages[0]?.content), /Return ONLY valid JSON/);
    assert.equal(trace.filter((event) => event.type === 'warning').length, 1);
    assert.equal(trace.filter((event) => event.type === 'model_usage').length, 2);
  });

  it('returns structured failure when retries are exhausted', async () => {
    const trace: CapabilityEvent[] = [];
    const model = new ScriptedProvider([
      textResponse('{"bad":1}'),
      textResponse('still no useful json'),
    ]);

    const result = await generateStructured({
      capabilityId: 'structured.test',
      model,
      userPrompt: 'Return a name.',
      validate: validateNamedValue,
      trace: { emit: (event) => trace.push(event) },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.attempts.length, 2);
    assert.match(result.error, /no parseable json|expected object/);
    assert.equal(trace.at(-1)?.type, 'error');
  });

  it('returns structured failure for model errors without retrying parser cleanup', async () => {
    const trace: CapabilityEvent[] = [];
    const model = new ScriptedProvider([new Error('provider offline')]);

    const result = await generateStructured({
      capabilityId: 'structured.test',
      model,
      userPrompt: 'Return a name.',
      validate: validateNamedValue,
      trace: { emit: (event) => trace.push(event) },
    });

    assert.deepEqual(result, {
      ok: false,
      error: 'provider offline',
      attempts: [{ attempt: 1, error: 'provider offline' }],
    });
    assert.equal(trace[0]?.type, 'warning');
  });

  it('throws aborts instead of converting cancellation into bad JSON', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new ScriptedProvider([textResponse('{"name":"Ada"}')]);

    await assert.rejects(
      () => generateStructured({
        capabilityId: 'structured.test',
        model,
        userPrompt: 'Return a name.',
        validate: validateNamedValue,
        signal: controller.signal,
      }),
      /aborted/i,
    );
    assert.equal(model.requests.length, 0);
  });
});
