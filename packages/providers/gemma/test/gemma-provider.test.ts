import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GemmaModelProvider } from '../src/index.js';
import type { ModelRequest } from '@aptkit/runtime';

// A recorded Gemma2:9b reply: prose wrapped around a fenced JSON tool call.
// This is the "messy blob" package A must decode — Gemma has no native
// tool-calling, so the tool call arrives as text inside the message content.
const recordedMessyToolCall = [
  'Sure! Let me look that up for you.',
  '',
  '```json',
  '{"tool": "get_weather", "arguments": {"location": "Paris", "unit": "celsius"}}',
  '```',
].join('\n');

const weatherRequest: ModelRequest = {
  messages: [{ role: 'user', content: 'What is the weather in Paris in celsius?' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a location.',
      inputSchema: { type: 'object' },
    },
  ],
};

describe('GemmaModelProvider', () => {
  it('decodes a messy Gemma tool-call blob into a clean tool_use block', async () => {
    const provider = new GemmaModelProvider({
      chat: async () => ({
        model: 'gemma2:9b',
        message: { role: 'assistant', content: recordedMessyToolCall },
      }),
    });

    const response = await provider.complete(weatherRequest);

    assert.equal(response.content.length, 1);
    const block = response.content[0];
    assert.ok(block, 'expected one content block');
    if (block.type !== 'tool_use') {
      throw new Error(`expected tool_use block, got ${block.type}`);
    }
    assert.equal(block.name, 'get_weather');
    assert.deepEqual(block.input, { location: 'Paris', unit: 'celsius' });
    assert.equal(typeof block.id, 'string');
    assert.ok(block.id.length > 0, 'tool_use block needs a non-empty id');
  });

  it('renders offered tools into a system instruction so Gemma can emulate tool calls', async () => {
    let captured: { messages: { role: string; content: string }[] } | undefined;
    const provider = new GemmaModelProvider({
      chat: async (payload) => {
        captured = payload;
        return { message: { role: 'assistant', content: 'ok' } };
      },
    });

    await provider.complete(weatherRequest);

    assert.ok(captured, 'transport should have been called');
    const system = captured.messages.find((m) => m.role === 'system');
    assert.ok(system, 'expected a system message carrying tool instructions');
    assert.match(system.content, /get_weather/);
    assert.match(system.content, /Get the current weather/);
    assert.match(system.content, /json/i);
  });

  it('returns a plain text block when Gemma answers without a tool call', async () => {
    const provider = new GemmaModelProvider({
      chat: async () => ({ message: { role: 'assistant', content: 'It is sunny in Paris.' } }),
    });

    const response = await provider.complete(weatherRequest);

    assert.equal(response.content.length, 1);
    assert.deepEqual(response.content[0], { type: 'text', text: 'It is sunny in Paris.' });
  });

  it('retries an unparseable tool-call attempt, then succeeds', async () => {
    const replies = ['Here you go: {oops not valid json', recordedMessyToolCall];
    let calls = 0;
    const provider = new GemmaModelProvider({
      chat: async () => ({ message: { role: 'assistant', content: replies[calls++] } }),
    });

    const response = await provider.complete(weatherRequest);

    assert.equal(calls, 2, 'should have retried once');
    const block = response.content[0];
    assert.ok(block && block.type === 'tool_use', 'retry should yield a tool_use');
    assert.equal(block.name, 'get_weather');
  });

  it('gives up after maxToolCallAttempts and returns the raw text', async () => {
    let calls = 0;
    const provider = new GemmaModelProvider({
      maxToolCallAttempts: 2,
      chat: async () => {
        calls += 1;
        return { message: { role: 'assistant', content: 'still broken {nope' } };
      },
    });

    const response = await provider.complete(weatherRequest);

    assert.equal(calls, 2, 'should stop after maxToolCallAttempts');
    assert.equal(response.content[0]?.type, 'text');
  });

  it('does not retry when the model answers in plain prose', async () => {
    let calls = 0;
    const provider = new GemmaModelProvider({
      chat: async () => {
        calls += 1;
        return { message: { role: 'assistant', content: 'It is sunny in Paris.' } };
      },
    });

    await provider.complete(weatherRequest);

    assert.equal(calls, 1, 'prose answers should not trigger a retry');
  });

  it('throws if the request is already aborted', async () => {
    const provider = new GemmaModelProvider({
      chat: async () => ({ message: { role: 'assistant', content: 'ok' } }),
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() =>
      provider.complete({ ...weatherRequest, signal: controller.signal }),
    );
  });

  it('gives each decoded tool call a unique id across turns', async () => {
    const provider = new GemmaModelProvider({
      chat: async () => ({ message: { role: 'assistant', content: recordedMessyToolCall } }),
    });

    const first = await provider.complete(weatherRequest);
    const second = await provider.complete(weatherRequest);

    const a = first.content[0];
    const b = second.content[0];
    assert.ok(a?.type === 'tool_use' && b?.type === 'tool_use');
    assert.notEqual(a.id, b.id, 'tool_use ids must be unique across calls');
  });
});
