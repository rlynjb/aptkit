# AptKit Studio

AptKit Studio is the manual testing surface for packaged capabilities. Use it when you want to verify behavior without remembering CLI replay commands.

## Start Studio

```sh
npm run dev:studio
```

Vite prints the local URL. If `5173` is already in use, it automatically chooses the next available port.

## Home & in-app docs

The landing screen is the **Capability Gallery** — Studio's home. Its header has links you can open without leaving Studio:

- **API Reference** — the `@rlynjb/aptkit-core` API docs, rendered in-app from [`core-api.md`](core-api.md).
- **User Guide** — *Reading & Evaluating Output*, rendered in-app from [`studio-guide.md`](studio-guide.md): how to read a run's output, trace, and eval, and judge quality.
- **npm** / **GitHub** — the published package and the repo.

The doc pages are rendered from the `docs/*.md` files via Vite's `?raw` import, so they're inlined into the build and also work in the static GitHub Pages demo (no backend).

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

### Rubric Improvement Agent

Validates agentic rubric feedback over a deterministic subject and judgment-history tool.

Use this page to check:

- fixture and OpenAI replay modes
- rubric dimension scoring and weakest-dimension selection
- history tool usage before final structured output
- next action and optional next drill output
- trace and eval status

### RAG Query Agent

Replays the RAG query agent (`@aptkit/agent-rag-query`) over a small in-browser knowledge base — fully deterministic, no Ollama or backend needed.

Use this page to check:

- the agent calling `search_knowledge_base`, the retrieved chunks (relevant ones highlighted), and the grounded, cited answer
- **retrieval quality** scored live: `precision@1` and `recall@k` over a labeled relevant set
- trace events (the search tool call + the synthesis turn) and eval status
- pick between fixtures (a two-part question, a single-source question) from the selector

Under the hood the retrieval pipeline runs in the browser: a deterministic keyword-hash embedder + `InMemoryVectorStore` index the fixture corpus, and recorded Gemma responses replay the tool-call → answer loop. For a *live* run against a real vector store (pgvector) and a real model, see the **buffr** companion runtime ([`studio-evaluation.md`](studio-evaluation.md) covers the eval side).

### Runtime & Eval Utilities

Validates non-agent package utilities with deterministic fixture providers.

Use this page to check:

- `generateStructured` retry and validation behavior
- `RubricJudge` prompt/validation flow
- `ensureGeneratedContent` section, angle, stale-cache, and skip behavior
- `FallbackModelProvider` plus `ContextWindowGuardedProvider`

The page uses fixture providers, so the result content is intentionally stable. The run number and timestamp confirm that **Run Fixtures** executed again.

## Studio Architecture

Studio has two page shapes:

- Agent replay pages use `AgentReplayShell` for the shared topbar, fixture selector, replay modes, provider status, run button, metrics, live trace state, and run counter.
- `Runtime & Eval Utilities` uses a custom dashboard because it previews non-agent utilities, not a single agent replay.

Agent replay pages also share:

- `useReplayArtifacts` for save, saved replay history, promoted fixture history, selected review replay, and promote state.
- `AgentStatusPanel` for fixture/status key-value summaries.
- `SaveReplayControl` for the primary workflow save action.
- Primitive panels such as `Metric`, `Panel`, `ProviderStatusPanel`, `PromptPackagePanel`, `TracePanel`, and `EvalPanel`.

Keep provider adapters, API routes, and app-specific data-source wiring outside the Studio shell. Studio should display and exercise packaged capabilities, not become the production runtime for an importing app.

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

For cross-cutting runtime/provider changes, use **Runtime & Eval Utilities** first, then run one agent page as an integration check. Agent pages should use the shared replay shell for fixture selection, runtime modes, provider status, live trace, and run state.

## CI Checks

Studio is still a manual preview app. Before committing Studio or package changes, run:

```sh
npm test
npm run build
npm run smoke:studio
git diff --check
```

The build includes the Studio TypeScript and Vite production build. The smoke test starts Studio on a fixed local port and verifies card navigation plus fixture rerun counters for Runtime & Eval Utilities, Rubric Improvement, Recommendation, Query, Diagnostic, and Monitoring.
