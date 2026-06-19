# AptKit

AptKit is a TypeScript monorepo for reusable AI capabilities extracted from working apps.

It packages the reusable parts of agent systems, provider adapters, tool registries, structured output parsing, evaluators, workflows, prompts, and Studio previews without baking app-specific product logic into the core package.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `packages/runtime` | Model provider contracts, bounded agent loop, trace events, JSON extraction, structured generation, usage accounting, NDJSON helpers. |
| `packages/tools` | Tool registry, tool policy, and coverage helpers. |
| `packages/context` | Workspace descriptors and schema summary helpers. |
| `packages/prompts` | Prompt packages and render helpers. |
| `packages/evals` | Replay assertions, structural diff, detection scoring, and rubric judge. |
| `packages/workflows` | Content-generation workflow and markdown section helpers. |
| `packages/agents/*` | Recommendation, anomaly monitoring, diagnostic investigation, and query agents. |
| `packages/providers/*` | Anthropic, OpenAI, fallback, and local context-window provider adapters. |
| `packages/core` | Public npm bundle published as `@rlynjb/aptkit-core`. |
| `apps/studio` | Manual preview and replay UI for packaged capabilities. |
| `docs` | Capability inventory, architecture notes, Studio guide, publishing notes, and migration plans. |

## Install

The public core bundle is available from npm:

```sh
npm install @rlynjb/aptkit-core
```

Existing apps can also alias it if they already import `@aptkit/core`:

```json
{
  "dependencies": {
    "@aptkit/core": "npm:@rlynjb/aptkit-core@^0.3.0"
  }
}
```

Provider packages are developed in this monorepo and are currently separate workspace packages. Host apps provide API keys through their own environment.

## Development

Install dependencies:

```sh
npm install
```

Run all package tests:

```sh
npm test
```

Build all packages and Studio:

```sh
npm run build
```

Run AptKit Studio:

```sh
npm run dev:studio
```

Vite prints the local Studio URL. If `5173` is already in use, it chooses the next available port.

Run the Studio browser smoke test:

```sh
npm run smoke:studio
```

## Studio

AptKit Studio is the preferred manual testing surface.

Current pages:

- Recommendation Agent
- Anomaly Monitoring Agent
- Diagnostic Investigation Agent
- Query Agent
- Runtime & Eval Utilities

Use fixture mode first for deterministic checks. Use OpenAI or Anthropic modes when validating real model behavior, provider adapters, and replay-promotion candidates.

See [docs/studio.md](docs/studio.md) for the manual smoke workflow.

## Capability Inventory

The packaged capability ledger is in [docs/capability-inventory.md](docs/capability-inventory.md).

The original operating plan is in [docs/ai-capability-library-plan.md](docs/ai-capability-library-plan.md).

Current state:

- P0/P1 extraction rows are packaged.
- The active work is Level 6 maturity: docs, examples, CI checks, versioning, and Studio preview coverage.
- Source-specific adapters and domain packs stay outside core unless their contracts become generic enough to reuse.

## Publishing Core

The public npm package is `@rlynjb/aptkit-core`.

Useful commands:

```sh
npm run build:core
npm run pack:core
```

Publishing notes live in [docs/npm-publishing.md](docs/npm-publishing.md).

## Design Rules

- Core APIs should use generic names such as `ModelProvider`, `ToolRegistry`, `WorkspaceDescriptor`, and `CapabilityEvent`.
- App-specific route handlers, cookies, OAuth flows, UI state, and domain data stay in apps or adapters.
- Provider SDKs belong in provider packages, not runtime.
- New capabilities should have fake or recorded fixtures before being marked package-ready.
- Studio should expose manual preview paths for capabilities that are useful to test visually.
