# Diagnostic Investigation Agent

Extracted from the Blooming Insights diagnostic agent as a reusable AptKit capability.

This package investigates a single anomaly, tests competing hypotheses through a `ToolRegistry`, and returns a structured diagnosis with evidence and confidence.

```ts
import { DiagnosticInvestigationAgent } from '@aptkit/agent-diagnostic-investigation';
```

The first fixture covers a seeded Sao Paulo revenue drop over an Olist-style ecommerce workspace.
