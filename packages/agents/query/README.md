# Query Agent

Extracted from the Blooming Insights free-form query agent as a reusable AptKit capability.

This package answers a natural-language workspace question by using a `ToolRegistry`, then returning grounded prose instead of a structured JSON object.

```ts
import { QueryAgent } from '@aptkit/agent-query';
```

The first fixture covers revenue by state over an Olist-style ecommerce workspace.
