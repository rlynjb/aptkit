# AI Engineering Resume Notes

## Fundamentals Resume Signals

Use fundamentals as the main resume signal. Tools change quickly, but these skills explain what you can actually build, debug, and operate.

- Python for backend automation, APIs, async workflows, testing, and packaging.
- TypeScript for production app surfaces, SDKs, and agent tooling.
- LLM application development with tool calling, structured outputs, prompt design, and provider adapters.
- Retrieval-augmented generation with embeddings, chunking, vector search, reranking, and source-grounded answers.
- Agent systems with planning, tool routing, memory, state management, task orchestration, and failure recovery.
- Evaluation workflows with golden datasets, regression tests, hallucination checks, and task success metrics.
- Usage and cost accounting for token spend, latency, retry behavior, model selection, and budget controls.
- ML fundamentals including transformers, embeddings, fine-tuning concepts, PyTorch, and Hugging Face workflows.
- MLOps and backend infrastructure with Docker, FastAPI, queues, Postgres, Redis, CI, and cloud deployment.
- Security fundamentals for least-privilege tokens, audit logs, approval gates, secret management, and production access controls.

## Hermes Usage Idea

Hermes is best positioned as a project platform, not just a named skill. The stronger resume story is using Hermes to automate real internal workflows through safe APIs and MCP tools.

Example project:

> Built an internal AI automation agent using Hermes and MCP to integrate Jira, Figma, Jenkins, Rancher, and Claude usage reporting; implemented scoped service accounts, read-only diagnostics, approval-gated actions, scheduled reports, and cost monitoring for AI-assisted engineering workflows.

Useful automation targets:

- Jira ticket summaries, stale issue detection, JQL reporting, release notes, sprint summaries, and ticket creation drafts.
- Figma design comment summaries, unresolved feedback reports, component change summaries, and ticket/design cross-checks.
- Claude usage dashboards from billing exports, gateway logs, proxy logs, or provider usage APIs.
- Jenkins build failure summaries, flaky job detection, safe job triggers, and deployment readiness reports.
- Rancher and Kubernetes read-only diagnostics for pod restarts, failed deployments, image versions, resource pressure, and cluster health.

Guardrails to mention:

- Start with read-only access before write actions.
- Use company-approved service accounts instead of personal credentials.
- Store secrets in a secret manager, not prompts or local config files.
- Add audit logs for every tool call and external action.
- Require human approval for writes, deploys, scaling, destructive operations, and production changes.
- Keep separate permissions for development, staging, and production.
- Prefer official APIs and MCP servers over browser automation for critical workflows.

Resume phrasing:

- Strong: `Built a Hermes-based internal automation agent with Jira, Figma, Jenkins, Rancher, and Claude usage integrations, using MCP tools, scoped service accounts, audit logging, and approval-gated production actions.`
- Weaker: `Skills: Hermes`

