# @aptkit/provider-gemma

A `ModelProvider` for Gemma served locally via [Ollama](https://ollama.com).

Package A of the personal-agent system — see `docs/personal-agent-packages.md`.

## What It Contains

- `GemmaModelProvider` — implements `ModelProvider` against Ollama's `/api/chat`.
- `GemmaChatTransport` — the injectable HTTP transport (lets tests feed recorded
  responses without a network call).

## The hard part: tool-call emulation

Gemma2:9b has **no native tool-calling**. This provider emulates it:

- **Outbound:** offered `tools` are rendered into the system text with an
  instruction to emit a JSON tool call (Gemma can't take a native `tools` array).
- **Inbound:** the model's reply is decoded with `parseAgentJson` (from
  `@aptkit/runtime`); a `{ "tool", "arguments" }` object becomes a clean
  `tool_use` block, otherwise the reply is returned as text.

## Example

```ts
import { GemmaModelProvider } from '@aptkit/provider-gemma';

const provider = new GemmaModelProvider(); // defaults: gemma2:9b @ localhost:11434

const response = await provider.complete({
  messages: [{ role: 'user', content: 'What is the weather in Paris in celsius?' }],
  tools: [{ name: 'get_weather', description: 'Get the current weather.', inputSchema: { type: 'object' } }],
});
// response.content -> [{ type: 'tool_use', name: 'get_weather', input: { ... } }]
```

Compose under `@aptkit/provider-local`'s `ContextWindowGuardedProvider` to guard
the local context window, and under `@aptkit/provider-fallback` for a cloud
fallback chain.

## Prerequisites

```
ollama pull gemma2:9b
```
