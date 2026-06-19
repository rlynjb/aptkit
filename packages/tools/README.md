# @aptkit/tools

Tool registry, policy, and coverage helpers for AptKit capabilities.

## What It Contains

- `ToolRegistry` contracts for model-callable tools.
- Fixture registries for package tests and Studio replays.
- Tool policy helpers for least-privilege tool grants.
- Coverage gate helpers for deciding which capability paths are runnable.

## Example

```ts
import { InMemoryToolRegistry, filterToolsForPolicy } from '@aptkit/tools';

const registry = new InMemoryToolRegistry(
  [{ name: 'get_metric', inputSchema: { type: 'object' } }],
  { get_metric: () => ({ value: 42 }) },
);

const tools = filterToolsForPolicy(await registry.listTools(), {
  capabilityId: 'query-agent',
  allowedTools: ['get_metric'],
});
```

Provider adapters should translate these generic tool definitions into provider-specific tool schema formats.
