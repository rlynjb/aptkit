# AptKit Studio

AptKit Studio is the manual testing surface for packaged capabilities. Use it when you want to verify behavior without remembering CLI replay commands.

## Start Studio

```sh
npm run dev:studio
```

Vite prints the local URL. If `5173` is already in use, it automatically chooses the next available port.

## Studio Pages

### Recommendation Agent

Validates the recommendation capability against seeded ecommerce fixtures.

Use this page to check:

- fixture, Anthropic, and OpenAI replay modes when providers are configured
- recommendation output shape and eval status
- trace events, model usage, tool calls, and warnings
- replay artifact save and promotion flow

### Anomaly Monitoring Agent

Validates workspace scanning and anomaly category coverage.

Use this page to check:

- fixture and OpenAI replay modes
- anomaly output shape and severity/category coverage
- schema capability gating
- trace events and model/tool sequencing

### Diagnostic Investigation Agent

Validates hypothesis-driven diagnosis for a known anomaly.

Use this page to check:

- diagnosis conclusion, evidence, confidence, and hypotheses
- deterministic fixture replay
- OpenAI replay when configured
- trace events and eval issues

### Query Agent

Validates free-form questions over a tool-backed workspace.

Use this page to check:

- natural-language answer generation
- intent classification expectations
- fixture and OpenAI replay modes
- trace and eval status

### Runtime & Eval Utilities

Validates non-agent package utilities with deterministic fixture providers.

Use this page to check:

- `generateStructured` retry and validation behavior
- `RubricJudge` prompt/validation flow
- `ensureGeneratedContent` section, angle, stale-cache, and skip behavior
- `FallbackModelProvider` plus `ContextWindowGuardedProvider`

The page uses fixture providers, so the result content is intentionally stable. The run number and timestamp confirm that **Run Fixtures** executed again.

## Modes

| Mode | Meaning |
| --- | --- |
| Fixture | Mock model/tool data. Deterministic, no API keys, fastest path for package checks. |
| Anthropic | Real Anthropic model with AptKit tool/provider seams. Requires `ANTHROPIC_API_KEY`. |
| OpenAI | Real OpenAI model with AptKit tool/provider seams. Requires `OPENAI_API_KEY`. |

Fixture mode is the default smoke path. Real-provider modes are for checking model behavior, prompt quality, provider adapters, and replay promotion candidates.

## Manual Smoke Path

After changing a capability or package API:

1. Start Studio with `npm run dev:studio`.
2. Open the page for the changed capability.
3. Run the fixture mode first.
4. Confirm the eval panel passes or shows expected issues.
5. Check the trace panel for unexpected warnings or missing tool/model events.
6. If the capability has provider support, run OpenAI next.
7. Save/promote replay artifacts only when the output is worth preserving as a future fixture.

For cross-cutting runtime/provider changes, use **Runtime & Eval Utilities** first, then run one agent page as an integration check.

## CI Checks

Studio is still a manual preview app. Before committing Studio or package changes, run:

```sh
npm test
npm run build
npm run smoke:studio
git diff --check
```

The build includes the Studio TypeScript and Vite production build. The smoke test starts Studio on a fixed local port and verifies the main card navigation plus the Runtime & Eval Utilities fixture rerun counter.
