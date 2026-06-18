# Recommendation Agent Extraction

This is the first AptKit extraction slice from `../blooming_insights`.

## Extracted Packages

- `@aptkit/runtime`: provider seam, trace events, JSON extraction, bounded model/tool loop.
- `@aptkit/tools`: tool registry and least-privilege tool policy filtering.
- `@aptkit/evals`: deterministic structural assertions.
- `@aptkit/provider-anthropic`: Anthropic Messages adapter behind `ModelProvider`.
- `@aptkit/provider-openai`: OpenAI Chat Completions adapter behind `ModelProvider`.
- `@aptkit/agent-recommendation`: recommendation capability with fixture replay.

## Source Boundary

`../blooming_insights` was used as read-only reference material. No source files were removed, edited, or moved from that repo.

## First Replay Fixture

The first replay fixtures are derived from Blooming Insights recommendation regression cases:

- `packages/agents/recommendation/fixtures/sp-revenue-drop.json`
- `packages/agents/recommendation/fixtures/electronics-spike.json`
- `packages/agents/recommendation/fixtures/voucher-dropoff.json`

Each includes:

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

## Studio Live Mode

Studio supports three recommendation replay modes:

- `Fixture`: browser-local scripted model/tool replay.
- `Anthropic`: server-side live model calls through `@aptkit/provider-anthropic`.
- `OpenAI`: server-side live model calls through `@aptkit/provider-openai`.

Live modes are disabled unless the dev server is started with the relevant key:

```sh
ANTHROPIC_API_KEY=... npm run dev:studio
OPENAI_API_KEY=... npm run dev:studio
```

Optional model overrides:

```sh
ANTHROPIC_MODEL=claude-sonnet-4-6
OPENAI_MODEL=gpt-4.1
```

Live mode still uses in-memory fixture tools. This tests real model behavior against deterministic tool results before connecting live data adapters.

## Package-Ready Criteria Still Open

- Add more fixtures for electronics spike and voucher dropoff.
- Add an app-facing demo surface.
- Add richer evals beyond structural shape.
- Add real adapter examples for Bloomreach/Olist tool registries.
- Add package-level versioning and changelog once APIs stabilize.
