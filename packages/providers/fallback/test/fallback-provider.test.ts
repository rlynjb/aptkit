import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FallbackModelProvider, ProviderFallbackError } from '../src/index.js';
import type { CapabilityEvent, ModelProvider, ModelRequest, ModelResponse } from '@aptkit/runtime';

describe('FallbackModelProvider', () => {
  it('uses the first successful provider and emits a warning for failed attempts', async () => {
    const events: CapabilityEvent[] = [];
    const provider = new FallbackModelProvider({
      providers: [
        failingProvider('openai', 'rate limit'),
        textProvider('anthropic', 'claude-test', 'fallback answer'),
      ],
      capabilityId: 'agent.test',
      trace: { emit: (event) => events.push(event) },
    });

    const response = await provider.complete({ messages: [] });
    assert.deepEqual(response.content, [{ type: 'text', text: 'fallback answer' }]);
    assert.equal(response.model, 'claude-test');
    assert.deepEqual(provider.lastSelectedProvider, { providerId: 'anthropic', model: 'claude-test' });
    assert.deepEqual(events.map((event) => event.type), ['warning']);
    assert.equal(events[0]?.capabilityId, 'agent.test');
  });

  it('throws ProviderFallbackError when every provider fails', async () => {
    const provider = new FallbackModelProvider({
      providers: [failingProvider('openai', 'quota'), failingProvider('anthropic', 'timeout')],
    });

    await assert.rejects(
      () => provider.complete({ messages: [] }),
      (error) => {
        assert.ok(error instanceof ProviderFallbackError);
        assert.deepEqual(error.attempts.map((attempt) => attempt.providerId), ['openai', 'anthropic']);
        return true;
      },
    );
  });

  it('does not fallback on abort errors', async () => {
    const provider = new FallbackModelProvider({
      providers: [
        {
          id: 'openai',
          async complete() {
            throw new DOMException('stopped', 'AbortError');
          },
        },
        textProvider('anthropic', 'claude-test', 'should not run'),
      ],
    });

    await assert.rejects(() => provider.complete({ messages: [] }), /stopped/);
  });

  it('honors custom fallback predicates', async () => {
    const provider = new FallbackModelProvider({
      providers: [failingProvider('openai', 'bad request'), textProvider('anthropic', 'claude-test', 'unused')],
      shouldFallback: () => false,
    });

    await assert.rejects(() => provider.complete({ messages: [] }), /bad request/);
  });
});

function textProvider(id: string, model: string, text: string): ModelProvider {
  return {
    id,
    defaultModel: model,
    async complete(_request: ModelRequest): Promise<ModelResponse> {
      return { content: [{ type: 'text', text }], model };
    },
  };
}

function failingProvider(id: string, message: string): ModelProvider {
  return {
    id,
    defaultModel: `${id}-test`,
    async complete(): Promise<ModelResponse> {
      throw new Error(message);
    },
  };
}
