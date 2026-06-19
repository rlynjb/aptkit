# @aptkit/runtime

Provider-neutral runtime primitives for AptKit capabilities.

## What It Contains

- `ModelProvider`, `ModelRequest`, and `ModelResponse` contracts.
- `runAgentLoop` for bounded tool-use agents.
- `CapabilityEvent` trace records and trace sinks.
- JSON extraction and validation helpers.
- NDJSON stream helpers for route/UI replay.
- `generateStructured` for bounded JSON retry workflows.
- Usage ledger helpers for token/accounting summaries.

## Example

```ts
import { generateStructured, type ModelProvider } from '@aptkit/runtime';

const model: ModelProvider = {
  id: 'fixture',
  async complete() {
    return {
      content: [{ type: 'text', text: '{"title":"Payment issue","priority":"high"}' }],
      usage: { inputTokens: 20, outputTokens: 12, estimated: true },
    };
  },
};

const result = await generateStructured({
  capabilityId: 'incident-brief',
  model,
  userPrompt: 'Return an incident brief as JSON.',
  validate(value) {
    if (value && typeof value === 'object' && 'title' in value) {
      return { ok: true, value: value as { title: string; priority: string } };
    }
    return { ok: false, error: 'missing title' };
  },
});
```

Runtime does not import provider SDKs or app frameworks. Hosts supply model providers, tool registries, persistence, and route/UI adapters.
