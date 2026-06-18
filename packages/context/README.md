# @aptkit/context

Shared context builders for data-backed AptKit capabilities.

This package owns the provider-neutral `WorkspaceDescriptor` shape and deterministic
workspace summary rendering used by agents, prompt previews, and replay provenance.

```ts
import { schemaSummary, type WorkspaceDescriptor } from '@aptkit/context';

const summary = schemaSummary(workspace);
```

Use capability-specific adapters outside this package to fetch or cache workspace
metadata. This package should stay deterministic and fixture-friendly.
