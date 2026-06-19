# @aptkit/provider-anthropic

Anthropic model-provider adapter for AptKit.

## What It Contains

- `AnthropicModelProvider`.
- Translation from AptKit `ModelRequest` messages/tools into Anthropic request payloads.
- Usage normalization into AptKit `ModelUsage`.

## Example

```ts
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicModelProvider } from '@aptkit/provider-anthropic';

const provider = new AnthropicModelProvider({
  client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-5',
});
```

Keep API keys in the host app environment. AptKit packages do not read secrets directly.
