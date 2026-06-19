# @aptkit/provider-fallback

Provider chain adapter for trying multiple `ModelProvider` implementations in order.

## What It Contains

- `FallbackModelProvider`.
- `ProviderFallbackError` with failed attempt details.
- Trace warnings when one provider fails and the next provider is tried.

## Example

```ts
import { FallbackModelProvider } from '@aptkit/provider-fallback';

const model = new FallbackModelProvider({
  providers: [localProvider, cloudProvider],
  capabilityId: 'recommendation-agent',
});

const response = await model.complete({
  messages: [{ role: 'user', content: 'Summarize this workspace.' }],
});
```

Use this when a host app wants local-first, provider-failover, or model-tier fallback without changing capability code.
