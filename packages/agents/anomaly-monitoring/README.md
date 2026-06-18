# @aptkit/agent-anomaly-monitoring

Extracted anomaly-monitoring capability based on the Blooming Insights monitoring agent.

This package contains:

- `AnomalyMonitoringAgent`: bounded model/tool loop for anomaly detection.
- Ecommerce category coverage gating.
- Workspace schema summarization.
- Anomaly output validation.
- Fixture replay with fake tools and fake model responses.

The package is app-agnostic: host apps provide a `ModelProvider`, `ToolRegistry`, and `WorkspaceDescriptor`.
