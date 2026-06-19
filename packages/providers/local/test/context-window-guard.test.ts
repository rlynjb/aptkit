import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ContextWindowExceededError,
  ContextWindowGuardedProvider,
  estimateContextWindow,
  estimateModelRequestTokens,
  estimateTextTokens,
} from '../src/index.js';
import type { CapabilityEvent, ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';

class FakeProvider implements ModelProvider {
  readonly id = 'local-fake';
  readonly defaultModel = 'tiny-local';
  calls = 0;

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return {
      content: [{ type: 'text', text: 'ok' }],
      model: this.defaultModel,
    };
  }
}

describe('local context window guard', () => {
  it('estimates text and model request tokens conservatively', () => {
    assert.equal(estimateTextTokens('abcdef', 3), 2);
    assert.equal(estimateTextTokens('abcdefg', 3), 3);
    assert.throws(() => estimateTextTokens('x', 0), /charsPerToken/);

    const tokens = estimateModelRequestTokens({
      system: 'system',
      messages: [{ role: 'user', content: 'hello world' }],
      tools: [{ name: 'search', inputSchema: { type: 'object' } }],
    }, 3);
    assert.equal(tokens > 0, true);
  });

  it('reports whether a request fits inside the reserved context window', () => {
    const estimate = estimateContextWindow({
      messages: [{ role: 'user', content: 'x'.repeat(30) }],
    }, {
      maxTokens: 20,
      outputReserve: 5,
      charsPerToken: 3,
    });

    assert.deepEqual(estimate, {
      estimatedInputTokens: 11,
      maxTokens: 20,
      outputReserve: 5,
      availableInputTokens: 15,
      ok: true,
    });
  });

  it('delegates to the wrapped provider when the request fits', async () => {
    const provider = new FakeProvider();
    const guarded = new ContextWindowGuardedProvider(provider, {
      maxTokens: 100,
      outputReserve: 20,
      charsPerToken: 3,
    });

    const response = await guarded.complete({
      messages: [{ role: 'user', content: 'short prompt' }],
    });

    assert.equal(provider.calls, 1);
    assert.equal(response.content[0]?.type, 'text');
  });

  it('throws before touching the wrapped provider when the request is too large', async () => {
    const provider = new FakeProvider();
    const trace: CapabilityEvent[] = [];
    const guarded = new ContextWindowGuardedProvider(provider, {
      maxTokens: 20,
      outputReserve: 8,
      charsPerToken: 3,
      trace: { emit: (event) => trace.push(event) },
    });

    await assert.rejects(
      () => guarded.complete({
        messages: [{ role: 'user', content: 'x'.repeat(100) }],
      }),
      ContextWindowExceededError,
    );

    assert.equal(provider.calls, 0);
    assert.equal(trace[0]?.type, 'warning');
  });
});
