# @aptkit/agent-recommendation

Extracted recommendation capability from the Blooming Insights workflow.

The package proposes 1-3 marketer-facing actions from an anomaly and diagnosis. It is provider-neutral: callers inject a `ModelProvider`, `ToolRegistry`, workspace descriptor, optional action taxonomy, and optional trace sink.

## Install In Workspace

```sh
npm install
npm run build
```

## Fixture Replay

Run the default recorded fixture without network or secrets:

```sh
npm run replay:fixture -w @aptkit/agent-recommendation
```

The default fixture is `fixtures/sp-revenue-drop.json`, derived from the Blooming Insights `06-recommendation-sp` regression case.

## Basic Usage

```ts
import { RecommendationAgent } from '@aptkit/agent-recommendation';
import { InMemoryToolRegistry } from '@aptkit/tools';

const agent = new RecommendationAgent({
  model,
  tools,
  workspace,
  trace: { emit: console.log },
});

const recommendations = await agent.propose(anomaly, diagnosis);
```

## Live Anthropic Usage

The agent does not import Anthropic directly. Use `@aptkit/provider-anthropic` at the app boundary:

```ts
import { AnthropicModelProvider } from '@aptkit/provider-anthropic';
import { RecommendationAgent } from '@aptkit/agent-recommendation';

const model = new AnthropicModelProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-6',
});

const agent = new RecommendationAgent({ model, tools, workspace });
```

Live provider tests should stay opt-in and must not run in CI without explicit credentials.

## Contract

Input:

- `Anomaly`
- `Diagnosis`
- `WorkspaceDescriptor`
- Optional `ActionTaxonomy`

Output:

- `Recommendation[]`

The model is asked to emit recommendations without `id`; this package validates the id-less shape, caps the output at three recommendations, then assigns ids through `idGenerator`.

## What Stayed Out

- Bloomreach OAuth and cookies.
- Next.js route handlers.
- UI streaming state.
- Concrete Bloomreach and Olist adapters.
- Source-app state files and live provider logs.
