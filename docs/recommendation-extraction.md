# Recommendation Agent Extraction

This is the first AptKit extraction slice from `../blooming_insights`.

## Extracted Packages

- `@aptkit/runtime`: provider seam, trace events, JSON extraction, bounded model/tool loop.
- `@aptkit/tools`: tool registry and least-privilege tool policy filtering.
- `@aptkit/evals`: deterministic structural assertions.
- `@aptkit/provider-anthropic`: Anthropic Messages adapter behind `ModelProvider`.
- `@aptkit/agent-recommendation`: recommendation capability with fixture replay.

## Source Boundary

`../blooming_insights` was used as read-only reference material. No source files were removed, edited, or moved from that repo.

## First Replay Fixture

`packages/agents/recommendation/fixtures/sp-revenue-drop.json` is derived from Blooming Insights regression fixture `06-recommendation-sp`. It includes:

- sanitized workspace descriptor,
- anomaly,
- diagnosis,
- scripted model responses,
- in-memory tool results,
- deterministic shape eval configuration.

Run it with:

```sh
npm run replay:fixture -w @aptkit/agent-recommendation
```

## Package-Ready Criteria Still Open

- Add more fixtures for electronics spike and voucher dropoff.
- Add an app-facing demo surface.
- Add richer evals beyond structural shape.
- Add real adapter examples for Bloomreach/Olist tool registries.
- Add package-level versioning and changelog once APIs stabilize.
