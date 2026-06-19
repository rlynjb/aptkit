# @aptkit/provider-local

Local-model guard utilities for provider adapters.

## What It Contains

- `ContextWindowGuardedProvider`.
- `estimateContextWindow`, `estimateModelRequestTokens`, and `estimateTextTokens`.
- `ContextWindowExceededError` for fallback chains.

## Example

```ts
import { ContextWindowGuardedProvider } from '@aptkit/provider-local';

const guarded = new ContextWindowGuardedProvider(localProvider, {
  maxTokens: 4096,
  outputReserve: 768,
  capabilityId: 'structured-generation',
});
```

The guarded provider estimates prompt size before calling the wrapped provider. If the request does not fit, it throws a structured error that a fallback provider can catch.
