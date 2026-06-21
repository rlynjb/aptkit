# Evaluating Agent Output Quality with AptKit Studio

This guide covers the quality-evaluation workflow: run a capability, inspect its
output and trace, read its eval scores, compare a fixture run against a live
provider run, and promote a good run to a correctness baseline.

It complements the general UI tour in [`studio.md`](./studio.md) (pages, modes,
smoke path) and the API symbol reference in [`core-api.md`](./core-api.md). Read
those for "what is Studio" and "what is the function signature"; this document is
about "how do I judge whether the output is good."

## 1. What "evaluating quality" means here

Quality evaluation in AptKit is **replay-centric**. You do not score a live model
call in isolation. You run a capability against a fixture (a frozen workspace,
tool set, and — in fixture mode — frozen model responses), capture the result as
a **replay artifact** (output + `trace` + `eval`), score that artifact with the
eval methods, and — when a run is worth keeping — **promote** it into a
deterministic fixture that becomes a regression baseline.

```
                          AptKit quality loop

   fixture            live or fixture run            artifact
  (frozen     ──────────────────────────────►   { schemaVersion,
   workspace,   AgentReplayShell.startReplay()      capabilityId,
   tools,       → /api/stream/<cap>/replay          output,
   model resps)    (live) or runFixture (det.)      trace: CapabilityEvent[],
                                                     eval: { ok, issues } }
                                                          │
                          ┌───────────────────────────────┤
                          │ inspect                        │ score
                          ▼                                ▼
                  output panel + trace          eval methods (packages/evals):
                  (tool_call_*, step,           structural-diff · detection-scorer
                   model_usage)                 rubric-judge · precision/recall@k
                          │                                │
                          └───────────────┬────────────────┘
                                          ▼
                            Save  →  POST /api/replay/save
                            (artifacts/replays/*.json)
                                          │
                            Promote  →  POST /api/<cap>/replays/promote
                                          ▼
                  packages/agents/<cap>/fixtures/promoted/<id>-<date>.json
                  (timestamped correctness baseline; deterministic replay
                   forever after via `npm run replay:<cap>:promoted`)
```

The artifact shape and the loop are both grounded in real code:
`apps/studio/src/replay-artifacts.ts` builds the artifact,
`apps/studio/vite.config.ts` runs/saves/promotes it, and
`packages/evals/src/*` scores it.

## 2. Run Studio

```sh
npm run dev:studio
```

This runs `npm run dev -w @aptkit/studio` (Vite). Vite prints the local URL,
defaulting to `5173` and choosing the next free port if taken. The home screen is
the **Capability Gallery** (`apps/studio/src/StudioHome.tsx`): one card per
capability — Recommendation, Anomaly Monitoring, Diagnostic Investigation, Query,
Rubric Improvement, plus Runtime & Eval Utilities. Each agent card opens a page
backed by the shared `AgentReplayShell`.

### Fixture mode vs live mode

The replay-mode switch in the shell topbar selects the provider
(`apps/studio/src/AgentReplayShell.tsx`):

- **Fixture** — deterministic. Uses each agent's `FixtureModelProvider` with the
  fixture's recorded `modelResponses`; no API key, no network. This is the
  baseline you compare everything else against.
- **Anthropic** / **OpenAI** — live. Calls the real provider with AptKit's
  tool/provider seams. Recommendation supports all three modes; Monitoring,
  Diagnostic, Query, and Rubric Improvement support `fixture` and `openai`
  (`parseMode` / `parseMonitoringMode` etc. in `vite.config.ts`).

Live modes are wrapped in a `FallbackModelProvider` so a configured second
provider backs up the primary (`providerWithConfiguredFallback`).

### The model-status check

On mount, the shell calls `loadProviderStatus()`
(`apps/studio/src/api.ts`) → **`GET /api/model-status`**. That route
(`vite.config.ts`) reports availability and model id per provider:

- `fixture` is always `available: true` (`fixture-model`)
- `anthropic` is available only when `ANTHROPIC_API_KEY` is set (default model
  `claude-sonnet-4-6`)
- `openai` is available only when `OPENAI_API_KEY` is set (default `gpt-4.1`)

A live mode whose key is missing renders as unavailable and its Run button is
disabled. Set keys in a workspace-root or `apps/studio` `.env`
(`loadStudioEnv`).

### STATIC_DEMO build

When built with `VITE_STATIC_DEMO=1`, Studio is read-only: it serves under base
`/aptkit/` and the client skips every backend call (`STATIC_DEMO` guards in
`AgentReplayShell.tsx` and `useReplayArtifacts.ts`). Fixture replays still run in
the browser, but provider status, saved-replay history, promoted-fixture history,
save, and promote are all disabled. Use the static build for a public preview;
use `npm run dev:studio` for actual evaluation.

## 3. Reading an output for quality

After a run, the shell stores a `ReplayStateFor<R>` and renders the metrics row
plus the capability panels. Three surfaces tell you whether the output is good.

### The output panel

Per-capability: recommendations array (Recommendation), anomalies (Monitoring),
diagnosis with conclusion/evidence/hypotheses (Diagnostic), prose answer (Query),
rubric result (Rubric Improvement). Read this first for correctness and grounding
— does the diagnosis cite real evidence, does the answer use the numbers the tool
returned, are the recommendations actionable?

### The trace (`CapabilityEvent[]`)

The trace is the *behavioral* record — how the output was produced. Event types
are defined in `packages/runtime/src/events.ts`:

| Event | What it tells you about quality |
| --- | --- |
| `tool_call_start` | `{ toolName, args }` — did the agent call the right tool with sensible arguments? Bad args (wrong metric, wrong date range) are visible here before the output is even wrong. |
| `tool_call_end` | `{ toolName, result?, error?, durationMs }` — did the tool return data or error? An `error` here usually explains a thin or hallucinated answer downstream. |
| `step` | `{ role, content }` — the model's assistant text at each turn; reasoning and the final structured emission. |
| `model_usage` | `{ provider, model, inputTokens, outputTokens, estimated }` — which model actually ran, and token cost per turn. `estimated: false` means real provider counts; `true` means inferred. |
| `warning` / `error` | runtime problems (malformed stream record, loop issue). Any of these is a quality red flag. |

A healthy live trace for a tool-using agent looks like
`tool_call_start → tool_call_end → model_usage → step` (see the Query artifact
`2026-06-18T19-29-11-225Z-revenue-by-state-query-fixture-studio.json`, whose
trace contains a real `get_metric_timeseries` call with args and a points
result). A fixture run with frozen single-shot responses may show only
`model_usage` and `step` (e.g. the OpenAI recommendation artifact below), which
is expected when no tool loop runs.

### The eval block

Every replay result carries an `eval`: `{ name, ok, issues[] }`. The shell exposes
this as `evalOk`, `evalIssueDetails` (`{ path, message }[]`), and the
flattened `evalIssues` (`api.ts` `to*ReplayResult`). `ok: true` with an empty
`issues` array is the pass condition. Each `issue` points at the exact failing
path (e.g. `recommendations.0.bloomreachFeature: required path is missing`), so a
red eval tells you *where* the output is malformed, not just *that* it is.

### modelTurns, durationMs, cost

`modelTurns` (from `modelTurnCount(trace)`) is the number of model round-trips;
unexpectedly high turn counts indicate a thrashing loop. `durationMs` is wall
time. The metrics row also derives a `costEstimate` from `summarizeUsage(trace)`
and `estimateCost(...)` (`replay-artifacts.ts`) — useful when comparing whether a
quality gain is worth the token cost.

### A real replay-artifact skeleton

Saved artifacts live in `artifacts/replays/*.json`. This is the actual structure
(trimmed from `2026-06-18T16-45-45-185Z-sp-revenue-drop-w4-openai.json`):

```jsonc
{
  "schemaVersion": 1,
  "createdAt": "2026-06-18T16:45:45.185Z",
  "durationMs": 14711,
  "provider": { "id": "openai", "model": "gpt-4.1" },
  "fixture": {
    "id": "sp-revenue-drop-w4",
    "description": "Fixture derived from ... recommendation regression case.",
    "path": "packages/agents/recommendation/fixtures/sp-revenue-drop.json"
  },
  // promptPackage provenance is added by the Studio client (id/version/hashes);
  // CLI-saved artifacts may omit it.
  "recommendations": [ { "id": "...", "title": "...", "bloomreachFeature": "scenario",
                         "steps": ["..."], "estimatedImpact": { "...": "..." },
                         "confidence": "medium" } ],
  "trace": [
    { "type": "model_usage", "capabilityId": "recommendation-agent", "provider": "openai",
      "model": "gpt-4.1-2025-04-14", "inputTokens": 1024, "outputTokens": 1063,
      "estimated": false, "timestamp": "2026-06-18T16:45:45.184Z" },
    { "type": "step", "capabilityId": "recommendation-agent", "role": "assistant",
      "content": "...", "timestamp": "..." }
  ],
  "eval": { "name": "recommendation-shape", "ok": true, "issues": [] },
  "modelTurns": 1
}
```

Per-capability the output key changes: `recommendations`, `anomalies`,
`diagnosis`, or `answer`, and non-recommendation artifacts also carry
`capabilityId`. The shapes are enforced by the `assert*ReplayArtifactShape`
functions in `packages/evals/src/assertions.ts`.

## 4. The eval methods

All live in `packages/evals/src/` and are re-exported from `@aptkit/evals`. Pick
the method by the *shape* of the thing you are judging.

### 4a. Structural diff — shape and required fields

**File:** `structural-diff.ts`. **Use when** the question is "is the output
well-formed and does it contain the required fields / text / counts?"

```ts
function evaluateStructuralDiff(value: unknown, rules: readonly StructuralDiffRule[]): StructuralDiffResult
// StructuralDiffResult = { ok: boolean; issues: { path; message }[] }
```

`StructuralDiffRule` is a tagged union: `required`, `equals`, `number` (with
tolerance), `arrayCount` (exact/min/max), `containsText`, `arrayIncludes` (with
optional `itemPath`). This is the cheapest, deterministic, no-model check. It
backs the shell's behavioral expectations — e.g. Studio turns a fixture's
`requiredFeatures` / `requiredText` into `arrayIncludes` / `containsText` rules
(`assertBehavioralExpectations` in `vite.config.ts`), and the `assert*Shape`
helpers in `assertions.ts` are thin wrappers over `assertRequiredPaths`. The
`eval` block you see in Studio is exactly this kind of result.

### 4b. Detection scorer — precision/recall/F1 over categorical fields

**File:** `detection-scorer.ts`. **Use when** the output is a *set of detections*
with categorical fields (the Anomaly Monitoring agent) and you want coverage
scored, not just shape checked.

```ts
function scoreDetections(detections: readonly DetectionLike[], expectations?: DetectionExpectations): DetectionScoreResult
// DetectionScoreResult = { ok; score; matched[]; missed[]; unexpected[]; issues[] }
```

`expectations` declares `minCount`/`maxCount` and the required `categories`,
`metrics`, `scopes`, `severities`. `score` is `(requirements − failures) /
requirements` in `[0,1]`; `matched`/`missed` list which requirements were hit,
and `unexpected` flags detected categories outside the expected set (a
false-positive signal). Studio uses this in `assertMonitoringBehavioralExpectations`
and, on promotion, derives the expectation set from the run's own anomalies
(`monitoringExpectationsFromAnomalies`).

### 4c. Rubric judge — LLM-as-judge for faithfulness / grounding

**File:** `rubric-judge.ts`. **Use when** quality is *subjective* — faithfulness,
grounding, actionability — and cannot be reduced to required fields or categorical
sets. This is the only eval method that calls a model.

```ts
class RubricJudge {
  constructor(options: { model; rubric: RubricDefinition; capabilityId?; maxTokens?; temperature?; trace? })
  judge(input: { subject; context? }, options?: { signal? }): Promise<StructuredGenerationResult<RubricJudgment>>
}
```

A `RubricDefinition` declares scored `dimensions` (each with a `scale`), allowed
`verdicts`, optional boolean `checks`, and `calibrationExamples`. The judge emits
a validated `RubricJudgment`: per-dimension `{ score, reason }`, an optional
`checks` map, a `verdict`, and a single highest-leverage `fix`. The validator
(`createRubricJudgmentValidator`) rejects scores outside each dimension's range
and verdicts not in the rubric — so the judge output is itself shape-checked.

**Anti-circular judge-model rule:** the judge model must be **stronger** than the
model under test, never the same model judging itself. The intended pairing is a
strong judge (e.g. Claude) scoring a weaker generator (e.g. Gemma). A model
grading its own output inflates scores and hides exactly the faithfulness failures
you are trying to catch. Pass the strong model explicitly as `RubricJudge`'s
`model`. (The Rubric Improvement agent itself uses the rubric machinery to *score
a subject* and produce a next action; see `studio.md`.)

### 4d. precision@k / recall@k — ranked-retrieval quality (RAG)

**File:** `precision-at-k.ts`. **Use when** you are scoring a *ranked retrieval*
result against a labeled relevant set — the RAG / Query retrieval path.

```ts
function scorePrecisionAtK(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): RetrievalScoreResult
function scoreRecallAtK(retrievedIds:   readonly string[], relevantIds: ReadonlySet<string>, k: number): RetrievalScoreResult
// RetrievalScoreResult = { ok; score; matched: number; total: number }
```

- **precision@k** = distinct relevant ids in the top-k / `min(k, retrieved)` —
  "of what I retrieved, how much was relevant?"
- **recall@k** = distinct relevant ids in the top-k / `|relevantIds|` — "of what
  was relevant, how much did I retrieve?"

Note `ok` here means *well-formed*, not *good*: it is `false` only when the metric
is undefined (`k <= 0`, or a zero denominator). A perfectly valid `score` of `0`
still has `ok: true`. See §8 for how this is used against the RAG agent.

### Structural assertions (the `assert*Shape` family)

`assertions.ts` provides ready-made structural gates over capability output and
over the artifact envelope: `assertRecommendationShape`, `assertAnomalyShape`,
`assertDiagnosticShape`, `assertQueryAnswerShape`, and the artifact-level
`assertReplayArtifactShape` / `assertMonitoringReplayArtifactShape` /
`assertDiagnosticReplayArtifactShape` / `assertQueryReplayArtifactShape`, plus the
dispatcher `assertCapabilityReplayArtifactShape`. The artifact asserts also
**require the embedded `eval.ok` to be `true`**, validate optional `promptPackage`
provenance, and scan for secret-like strings — so a malformed-but-passing artifact
cannot be promoted. These are the gate the save/promote paths and the CLI run.

## 5. Fixture vs live comparison

To spot quality drift, run the **same fixture** twice — once in `fixture` mode
(the deterministic baseline) and once live (`openai`/`anthropic`) — and compare
the two artifacts. Studio supports this directly:

- The shell records each run's `usage`, `costEstimate`, `modelTurns`, and
  `durationMs`, and `replay-artifacts.ts` builds `ComparisonState` from the saved
  fixture-mode and openai-mode replays for a fixture
  (`comparisonForFixture` / `comparisonForMonitoringFixture`,
  `latestReplayFor(replays, fixtureId, providerId)`).
- Output-level diffing is exposed via `featureSet(replay)` (recommendation
  `bloomreachFeature` values) and `monitoringCategorySet(replay)` (anomaly
  categories), with `formatDelta` / `formatCostDelta` for the numeric and cost
  differences.

Read the comparison this way: the fixture run is your known-good answer. If the
live run drops a required `bloomreachFeature`, loses an anomaly category, costs
materially more tokens for the same output, or takes more `modelTurns`, that is
drift — investigate the trace before trusting the live model. Saved replays are
keyed by `fixture.id` + `provider.id`, so the comparison always pairs the right
two runs.

## 6. Promote to a baseline

When a run is genuinely good, promote it so it becomes a frozen regression
fixture. There are two equivalent entry points.

**From Studio** — `useReplayArtifacts.promoteSavedReplay(path)` (`api.ts`
`promote*Replay`) POSTs the saved artifact path to the capability's promote route:

- **`POST /api/replays/promote`** — recommendation
- **`POST /api/monitoring/replays/promote`** — monitoring
- **`POST /api/diagnostic/replays/promote`** — diagnostic
- **`POST /api/query/replays/promote`** — query

(All defined in `vite.config.ts`; each resolves the artifact under
`artifacts/replays/`, validates it, and writes a promoted fixture.)

**From the CLI** — `npm run promote:replay -- artifacts/replays/<file>.json`
(`scripts/promote-replay-to-fixture.mjs`).

Either way the flow is: validate the artifact with the matching
`assert*ReplayArtifactShape` (**a run that fails its eval cannot be promoted** —
`promoteCapabilityReplayArtifact` throws on a failing validation), load the source
fixture by `fixture.path`, capture the run's final output as a deterministic
`modelResponses` entry, derive behavioral `expectations` from that output, attach
a `promotion` provenance block (`sourceArtifact`, `sourceProvider`, `promotedAt`,
a note), and write to:

```
packages/agents/<capability>/fixtures/promoted/<promoted-id>-<artifact-date>.json
```

The filename is timestamped (`<id>-YYYY-MM-DD-HH-MM-SS.json`), so a promoted
fixture is an immutable, dated correctness baseline. **Do not hand-edit promoted
fixtures.** Their value is provenance: each one is a verbatim capture of a real
run plus the assertions derived from it. Editing the recorded answer or the
derived expectations silently decouples the baseline from any run that ever
happened, defeating the regression guarantee. To change a baseline, promote a new
run; the old dated file stays as history.

Studio lists existing baselines via the read-only routes
**`GET /api/promoted-fixtures`**, **`/api/promoted-monitoring-fixtures`**,
**`/api/promoted-diagnostic-fixtures`**, and **`/api/promoted-query-fixtures`**,
each re-running its promoted fixtures in fixture mode and reporting `evalOk` +
`behaviorOk`.

(Save, which precedes promote, is **`POST /api/replay/save`**; the saved-replay
history list is **`GET /api/replays`**, filtered client-side by `capabilityId`.)

## 7. Batch eval from the CLI (CI-style quality gates)

Two scripts turn the same checks into non-interactive gates.

**Evaluate every saved artifact:**

```sh
npm run eval:replays                                   # all of artifacts/replays
npm run eval:replays -- artifacts/replays/<file>.json  # one file
npm run eval:replays -- --dir <path>                   # custom dir
```

`scripts/eval-replay-artifacts.mjs` calls `listReplayArtifacts` +
`evaluateReplayArtifactFiles` from `@aptkit/evals/replay-runner`. It runs
`assertCapabilityReplayArtifactShape` on each artifact and prints
`{ ok, checked, failed, results[] }`, exiting non-zero if any artifact fails — a
drop-in CI gate over your captured runs.

**Re-replay the promoted baselines:**

```sh
npm run replay:recommendation         # fixture-mode smoke of the base fixture
npm run replay:monitoring:promoted    # re-run every promoted monitoring baseline
npm run replay:diagnostic:promoted
npm run replay:query:promoted
```

The `:promoted` scripts (`scripts/replay-promoted-fixtures.mjs`, run per-package)
re-execute each promoted fixture deterministically and assert both its shape eval
and its derived behavioral expectations, exiting non-zero on any failure. This is
the regression gate: if a code change alters a baseline's output, the promoted
replay fails. Studio's own manual gate is `npm run smoke:studio` (see
`studio.md`).

## 8. Evaluating the RAG agent specifically

RAG quality splits into two independently scored halves.

**Retrieval — precision@k / recall@k over a labeled query set.** Build a golden
set of `query → relevant docIds` pairs, run each query through the *exact*
retrieval path the agent uses, take the ranked `retrievedIds`, and score:

```ts
scorePrecisionAtK(retrievedIds, new Set(relevantIds), 1);   // precision@1
scoreRecallAtK(retrievedIds,    new Set(relevantIds), 3);   // recall@3
```

This is cheap, deterministic, and model-free. In the **buffr** companion repo
this is exactly the live eval: `src/cli/eval-cmd.ts` runs a hand-labeled golden
set through the agent's retrieval path and prints **precision@1** and
**recall@3** using `scorePrecisionAtK` / `scoreRecallAtK` from `@aptkit/evals`.
AptKit ships the **scorers** (`packages/evals/src/precision-at-k.ts`) and the
**Studio Query replay surface** (the Query Agent page, `runQueryReplay`, and the
`get_metric_timeseries`-style tool trace you can inspect per §3); the labeled
golden-set runner lives in the consuming app.

**Faithfulness — `RubricJudge`.** Retrieval metrics say nothing about whether the
*answer* follows from the retrieved chunks. A run can score precision@1 = 1.0 and
still hand back a hallucinated answer. To close that gap, score the generated
answer against a faithfulness/grounding `RubricDefinition` with `RubricJudge`,
passing the retrieved chunks as `context` and the answer as `subject`. Apply the
§4c anti-circular rule: judge with a **stronger** model than the one that
generated the answer. (Note: buffr currently measures retrieval but does *not*
wire the faithfulness judge — `RubricJudge` ships unused there, which is precisely
the gap this method fills.)
