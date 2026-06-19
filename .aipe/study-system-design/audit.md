# Pass 1 — the system-design audit

Eight lenses, walked against real `file:line` evidence. Each lens names what AptKit actually does, or says `not yet exercised` honestly. When a finding is big enough to deserve a full walk, it cross-links to a Pass 2 pattern file rather than restating it.

The honest framing up front: this is a **library monorepo**, not a deployed distributed system. Five of the eight lenses have rich findings (boundaries, flow, state, failure, evolution). The caching and scale lenses are mostly `not yet exercised` — and that's correct, not a gap to paper over. There's no traffic, no datastore, no replicas.

---

## 1. system-map-and-boundaries

Every major component, its responsibility, and its trust boundaries. The full picture is in `00-overview.md`; this lens names the boundaries.

**Layered dependency boundary (the spine).** `packages/runtime` has zero internal dependencies — it's the foundation everything points at. The dependency arrow always points *toward* runtime: agents depend on runtime + tools + context + prompts; providers depend only on runtime's `ModelProvider` contract; core depends on all eleven. This is enforced by the build order in `package.json:14` (`build:core:deps`), which compiles runtime first, then tools/context/prompts/evals/workflows, then the five agents, then core last (`package.json:15`).

**The central seam — `ModelProvider.complete()`** (`packages/runtime/src/model-provider.ts:54-58`). Every model call in the entire system crosses this one interface. No agent, no loop, no eval ever touches `@anthropic-ai/sdk` or `openai` directly. → see `01-provider-abstraction.md`.

**Trust boundaries.** There are two real ones:
- **The vendor SDK call** (`packages/providers/anthropic/src/anthropic-provider.ts:29-39`, `packages/providers/openai/src/openai-provider.ts:39-48`) — the only place data leaves the process, over HTTPS. API keys are read from env (`process.env.ANTHROPIC_API_KEY`, `process.env.OPENAI_API_KEY`), gitignored in `.env`.
- **The tool-policy boundary** (`packages/tools/src/tool-policy.ts:11-23`) — each agent can only see the tools on its allowlist. This is a *capability* boundary, not a security perimeter, but it's a real containment seam. → see `04-capability-as-tool-policy.md`.

**The publish boundary** (`packages/core/package.json:44-56`). `bundledDependencies` inlines all eleven internal packages into one tarball; the must-not-change rule is that app-specific product logic never crosses *into* core. → see `08-monorepo-bundle-boundary.md`.

**External dependencies:** Anthropic HTTP API (`@anthropic-ai/sdk ^0.60`, default `claude-sonnet-4-6`), OpenAI HTTP API (`openai ^6.44`, default `gpt-4.1`). That's the entire external surface. No database, no cache server, no message broker.

---

## 2. request-response-and-data-flow

The important end-to-end flows.

**The inner flow — one agent run** (`packages/runtime/src/run-agent-loop.ts:98-190`). A capability method seeds a user message, then loops: `model.complete()` → if the response has tool-use blocks, execute them via the registry and feed results back as a user message → repeat until the model stops calling tools or the budget is spent. The loop is bounded and forces a final synthesis turn. → see `02-bounded-agent-loop.md`.

**The pipeline flow — monitor → diagnose → recommend** (wired in `apps/studio/vite.config.ts` and `apps/studio/src/agent-runners.ts`). `anomaly-monitoring.scan()` returns `Anomaly[]`; one anomaly feeds `diagnostic-investigation.investigate(anomaly)` → `Diagnosis`; both feed `recommendation.propose(anomaly, diagnosis)` → `Recommendation[]`. The output type of each stage is the input type of the next — a typed handoff. → see `05-multi-agent-pipeline.md`.

**The Studio flow — replay over the wire** (`apps/studio/vite.config.ts:887-918` server, `apps/studio/src/api.ts:119-166` client). Click "Replay" → `fetch` POST to a Vite middleware route → the route runs the agent with an `onEvent` callback that writes each `CapabilityEvent` as an NDJSON line → the React client decodes the stream incrementally and accumulates a live trace. → see `07-ndjson-stream-handoff.md`.

**The eval flow — the testing backbone** (`packages/evals/src/replay-runner.ts`, `scripts/*.mjs`). Live run → write artifact JSON → evaluate → promote to fixture → deterministic replay. → see `06-replay-eval-pipeline.md`.

No parallel fan-out anywhere — every flow is sequential. The agent loop is sequential by construction (each turn depends on the last), the pipeline is sequential by data dependency, and the fallback chain is sequential by design.

---

## 3. state-ownership-and-source-of-truth

Who owns each piece of state and who mutates it.

**The agent loop owns conversation state** (`packages/runtime/src/run-agent-loop.ts:94-96`). The `messages` array, `toolCalls` record, and `finalText` are local to one `runAgentLoop` invocation — born when the loop starts, gone when it returns. No state survives between runs. This is the cleanest kind of state ownership: there isn't any to leak.

**The trace is append-only, owned by the caller's sink** (`packages/runtime/src/events.ts:26-28`). The loop never holds the trace — it `emit()`s `CapabilityEvent`s to a `CapabilityTraceSink` the caller provides. Studio's sink accumulates into React state (`apps/studio/src/AgentReplayShell.tsx:91-96`); a script's sink pushes to an array. The runtime owns *producing* events; the caller owns *storing* them. Clean separation. → schema shape is owned by `.aipe/study-data-modeling/`.

**The replay artifact is the durable source of truth for "what happened"** (`artifacts/replays/*.json`). Keys: `schemaVersion`, `capabilityId`, `createdAt`, `durationMs`, `provider`, `fixture`, the per-capability output, `trace`, `eval`, `modelTurns`. It's the only thing written to disk during a live run.

**The fixture is the source of truth for "what should happen"** (`packages/agents/*/fixtures/*.json`, `fixtures/promoted/*.json`). A fixture's `modelResponses: ModelResponse[]` is replayed in order by `FixtureModelProvider` (`packages/agents/recommendation/src/fixture-provider.ts:3-18`). Promoted fixtures are correctness baselines — the must-not-change rule (`context.md`) says they're regenerated via `promote:replay`, never hand-edited.

**`WorkspaceDescriptor` is read-only input state** (`packages/context`). It's metadata about a workspace (events, catalogs, totals, data horizon) summarized into prompts — never mutated by an agent.

No URL state, no form state, no client-side persistence beyond React component state in Studio. No server-side session store.

---

## 4. caching-and-invalidation

**Mostly `not yet exercised`.** There is no cache layer, no memoization of model calls, no TTL, no invalidation strategy. Every live `model.complete()` hits the vendor API fresh.

The one thing that *rhymes* with caching is the **fixture-as-recorded-response** mechanism (`FixtureModelProvider`, `packages/agents/*/src/fixture-provider.ts`): a recorded `ModelResponse[]` replayed deterministically instead of calling the model. That's not a cache (no freshness logic, no key-based lookup, no invalidation) — it's a *test double*. But it occupies the architectural slot a response cache would, and it's why eval runs cost zero tokens. → see `06-replay-eval-pipeline.md`.

If this repo ever needs a real cache (e.g. dedup identical `complete()` calls), the `ModelProvider` seam is exactly where a caching decorator would slot in — same shape as `ContextWindowGuardedProvider` already uses. Worth naming as the natural future seam.

---

## 5. storage-choice-and-durability-boundaries

**No datastore.** Per `context.md`, there is no SQL/relational database. "Data" is file- and stream-shaped:

- **NDJSON streams** — `CapabilityEvent`s encoded one-per-line (`packages/runtime/src/ndjson-stream.ts:31-33`). Ephemeral on the wire to Studio; durable when a script writes them into an artifact's `trace`.
- **JSON files on the filesystem** — replay artifacts (`artifacts/replays/*.json`), fixtures (`packages/agents/*/fixtures/*.json`). Durability is "whatever the filesystem and git give you." Promoted fixtures are committed; replay artifacts are working output.

Why no database? Because nothing here needs one. The agents are stateless request-shaped capabilities; the only persistent data is test fixtures and observability records, both of which are git-tracked JSON. Adding Postgres would be architecture for its own sake.

The durability guarantee that *does* matter: **promoted fixtures are correctness baselines** and must survive unchanged (`context.md` must-not-change constraints). The "boundary" is the `fixtures/promoted/` directory plus the rule that they're only regenerated, never hand-edited. → schema shape lives in `.aipe/study-data-modeling/`.

---

## 6. failure-handling-and-reliability

The richest lens after the boundaries lens — failure handling is genuinely designed here, not bolted on.

**Bounded work is the primary reliability mechanism** (`packages/runtime/src/run-agent-loop.ts:98-102`). The loop *cannot* run forever: `for (let turn = 0; turn < maxTurns; turn += 1)` plus the `maxToolCalls` budget. A misbehaving model that keeps calling tools hits a hard ceiling and gets forced into a final answer (`forceFinal` at line 102 strips tools so the model *must* synthesize). → see `02-bounded-agent-loop.md`.

**Provider fallback** (`packages/providers/fallback/src/fallback-provider.ts:47-89`). If one provider throws (rate limit, outage, bad key), the chain tries the next. Abort signals are preserved (`isAbortError`), and a customizable `shouldFallback` predicate can stop the chain early. Exhausting the chain throws a `ProviderFallbackError` carrying every attempt. → see `03-fallback-chain.md`.

**Context-window guard** (`packages/providers/local/src/context-window-guard.ts:57-70`). Pre-flight token estimation rejects an over-budget request *before* it's sent — throws `ContextWindowExceededError` and emits a warning rather than letting the vendor reject it. Composed in front of a provider, ahead of or inside the fallback chain. → see `03-fallback-chain.md`.

**Structured-generation retry** (`packages/runtime/src/structured-generation.ts:62-100`). When a model returns malformed JSON, it retries up to `maxAttempts` (default 2), appending a strict "return ONLY valid JSON" suffix on the retry. Failure emits an error event and returns `{ ok: false }` — degraded, not crashed.

**Loop-level recovery** (`packages/runtime/src/run-agent-loop.ts:192-228`). If `parseResult` returns null after the loop, an optional `recoveryPrompt` triggers one more bare model call to coax a parseable answer. Recovery failures emit warnings but don't propagate.

**Graceful degradation everywhere.** The query agent returns a `FALLBACK_ANSWER` if the loop produces nothing (`packages/agents/query/src/query-agent.ts:101`). Anomaly monitoring returns `[]` rather than failing when no anomaly is found.

Partial failure across a *process boundary*? `not yet exercised` — there's only one synchronous external call (the SDK), and its failure is handled by the fallback chain. No two-phase commit, no saga, no distributed retry. → coordination mechanics would belong to study-distributed-systems.

---

## 7. scale-bottlenecks-and-evolution

What breaks first, and what would force a rearchitecture.

**At 10x usage (10x more agent runs):** nothing in *this* repo breaks first — the bottleneck is the **vendor API rate limit and cost**, which is external. The fallback chain (`03-`) already routes around a single provider's limit; the next move would be a response cache at the `ModelProvider` seam (the slot named in lens 4) and request batching. Both slot into the existing seam without touching agents.

**At 10x fixtures/replays:** the eval pipeline reads every artifact file synchronously (`packages/evals/src/replay-runner.ts:70-94`, `evaluateReplayArtifactFiles` loops files one at a time). That's fine at tens of fixtures; at thousands it's a linear file-IO scan with no parallelism. Stays stable far longer than you'd think because evals run in CI, not the hot path.

**What stays stable under any growth:** the `ModelProvider` contract, `CapabilityEvent`, `ToolRegistry`, `WorkspaceDescriptor` (`context.md` names these the load-bearing contracts). They're narrow interfaces; growth happens behind them.

**What would force a rearchitecture:** moving from "library a host app imports" to "hosted service with traffic." That introduces everything currently `not yet exercised` — an HTTP server, auth, a request queue, a real datastore for traces, horizontal replicas. The current architecture has *no server* (Studio's Vite middleware is a dev convenience, not production). That's the cliff. Everything up to it is incremental.

---

## 8. system-design-red-flags-audit

Ranked architectural risks, each grounded in real evidence. These are honest observations, not alarms — most are "fine for a library, would bite as a service."

1. **The pipeline orchestration lives in Studio, not in a package** (`apps/studio/vite.config.ts`, `apps/studio/src/agent-runners.ts`). The monitor→diagnose→recommend wiring is in the dev app, not in `packages/`. A host app importing core gets the five agents but has to re-wire the pipeline itself. If the pipeline is a real product capability, it belongs in a package with its own contract. Right now it's only demonstrated, not shipped. → `05-multi-agent-pipeline.md` walks this.

2. **OpenAI cost pricing only covers `gpt-4.1-*`** (`context.md` notes this; `usage-ledger.ts`). The usage/cost ledger silently under-reports for any other OpenAI model. Low blast radius (it's observability, not behavior), but a model swap would produce wrong cost numbers without erroring.

3. **`rubric-improvement` has no `replay:promoted` script wired into the root pipeline** (`context.md`). The other four agents have deterministic regression coverage via promoted fixtures; this one doesn't. It can drift under a model update without a test catching it. → `06-replay-eval-pipeline.md` covers what the others get that this one misses.

4. **Token estimation is a `charsPerToken` heuristic** (`packages/providers/local/src/context-window-guard.ts:100-103`, default 3 chars/token). It's a coarse approximation — a request near the budget edge could be wrongly admitted or wrongly rejected. Fine as a guard rail; not a precise accountant. The code is honest about this (it's an *estimate*).

5. **No cache means identical `complete()` calls re-hit the API** (lens 4). Not a bug, but at scale it's wasted cost. The seam to fix it already exists.

None of these are "stop the ship." They're the difference between a clean library and a production service — which is exactly the line this repo sits on.
