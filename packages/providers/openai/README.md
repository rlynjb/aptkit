# @aptkit/provider-openai

OpenAI model-provider adapter for AptKit.

## What It Contains

- `OpenAiModelProvider`.
- Translation from AptKit `ModelRequest` messages/tools into OpenAI request payloads.
- Usage normalization into AptKit `ModelUsage`.

## Example

```ts
import OpenAI from 'openai';
import { OpenAIModelProvider } from '@aptkit/provider-openai';

const provider = new OpenAIModelProvider({
  client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  model: 'gpt-4.1-mini',
});
```

Keep API keys in the host app environment. AptKit packages do not read secrets directly.
