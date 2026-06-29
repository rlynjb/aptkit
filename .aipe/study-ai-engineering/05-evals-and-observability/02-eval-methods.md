# Eval methods

**Subtitle:** The cheap→expensive scoring ladder · four real scorers in `@aptkit/evals` · *Industry standard*

## Zoom out, then zoom in

Once you have an eval set, you have to *score* against it — and scoring methods
form a ladder from cheap-and-strict to expensive-and-fuzzy. The principle is to
climb only as high as the output demands: a fixed-shape JSON object can be checked
with an exact rule; a free-form paragraph needs a model to judge it. aptkit has a
scorer at four rungs of that ladder, each its own module in `@aptkit/evals`.

```
  Zoom out — the eval-method ladder (cheap/strict at the bottom)

  ┌─ HUMAN ──────────────────────────────────────────────┐  expensive, slow,
  │  a person reads it                                    │  highest fidelity
  ├─ RUBRIC / LLM-AS-JUDGE ───────────────────────────────┤
  │  ★ rubric-judge.ts — a model scores meaning ★         │  fuzzy outputs
  ├─ RANKED RETRIEVAL ────────────────────────────────────┤
  │  precision-at-k.ts — ordered list quality             │  retrieval
  ├─ DETECTION SCORING ───────────────────────────────────┤
  │  detection-scorer.ts — did it find the right things?  │  set membership
  ├─ EXACT MATCH / STRUCTURAL RULES ──────────────────────┤
  │  structural-diff.ts — does the shape/value hold?      │  cheap, strict,
  └────────────────────────────────────────────────────────┘  deterministic
```

Now zoom in. The trap beginners fall into is reaching for the LLM judge first
because it feels powerful. It's the opposite — the judge is the *last* resort,
because it's slow, costs tokens, and is itself fallible (see
`03-llm-as-judge-bias.md`). The skill is choosing the lowest rung that can
actually catch the failure you care about. aptkit's modules let you do exactly
that, picking the scorer per output type.

## Structure pass

**Layers.** A capability produces output → a scorer at the right rung evaluates it
→ the result (`{ok, issues}` or `{ok, score, ...}`) flows into a test assertion or
a replay summary.

**Axis — cost (and with it, determinism).** Trace the cost of a single eval down
the ladder. `evaluateStructuralDiff` is pure, synchronous, free, and
deterministic (`structural-diff.ts:20`). `scoreDetections` and `scorePrecisionAtK`
are the same — pure functions over arrays. `RubricJudge.judge` makes a *model
call* (`rubric-judge.ts:92`) — async, costs tokens, non-deterministic. Cost and
determinism move together: the cheap rungs are exact and repeatable, the expensive
rung is fuzzy and variable. Pick the cheapest rung that still distinguishes pass
from fail.

**Seam.** The shared result shape. Every scorer returns an object with `ok:
boolean` and either `issues` or `score` (`StructuralDiffResult`,
`DetectionScoreResult`, `RetrievalScoreResult`). Above that seam, a test or a
Studio summary treats all four uniformly; below it, each scorer is free to be as
cheap or as expensive as its rung requires.

## How it works

### Move 1 — the mental model

This is the **assertion-strength** decision you already make in every test you
write. `assert(x === 3)` is the strictest, cheapest check — exact equality.
`assert(arr.includes('a'))` is looser — membership. `assert(result.score > 0.8)`
is looser still — a threshold. And `assert(reviewer.approves(prose))` is the
loosest and most expensive — judgment. You don't reach for the fuzzy assertion
when an exact one works; the same instinct picks the eval rung.

```
  Assertion strength  ─analogy─►  eval-method rung

  x === 3                 ─►   structural-diff: equals / required
  arr.includes('a')       ─►   detection-scorer: required category found
  score > 0.8             ─►   precision@k: ranked-list threshold
  reviewer.approves(text) ─►   rubric-judge: model scores meaning
```

A test fails loudly with a wrong assertion *type* — too strict and it's flaky,
too loose and it passes garbage. Same here: scoring a paragraph with `equals`
fails on whitespace; scoring a JSON shape with a rubric judge is slow and
non-deterministic for no gain. Match the rung to the output.

### Move 2 — the four scorers, rung by rung

**Rung 1 — exact match / structural rules (`structural-diff.ts`).** The cheapest
scorer. `evaluateStructuralDiff` runs a list of typed rules against any JSON-like
value and returns `{ok, issues}` (`structural-diff.ts:11`):

```ts
export type StructuralDiffRule =
  | { type: 'required'; path: string }                                  // path exists
  | { type: 'equals'; path: string; expected: unknown }                 // exact value
  | { type: 'number'; path: string; expected: number; tolerance?: number } // ± tolerance
  | { type: 'arrayCount'; path: string; exact?; min?; max? }            // length bounds
  | { type: 'containsText'; path: string; text: string }               // substring
  | { type: 'arrayIncludes'; path: string; value: unknown; itemPath? };// membership
```

This is the rung the whole replay backbone rides on:
`assertReplayArtifactShape` is just a pile of `required` rules plus a few `equals`
(`assertions.ts:58`) — `schemaVersion === 1`, `provider.id` present, an ISO
`createdAt`, `eval.ok === true`. Note the `number` rule's `tolerance`
(`structural-diff.ts:112`): for a metric you assert `42 ± 0.5`, because a float
that drifts in the last digit shouldn't fail a test.

```
  Rung 1 — structural rules over a JSON value

  artifact ─► [required schemaVersion, equals provider.id, number(42, tol .5), ...]
                                │
                                ▼
                       { ok, issues:[{path, message}] }   deterministic, free
```

**Rung 2 — detection scoring (`detection-scorer.ts`).** When the output is a *set*
of findings — anomalies, categories — exact match is wrong (order and count vary).
`scoreDetections` asks "did it find the things it should, and not too many extra?"
(`detection-scorer.ts:29`). It tallies `matched` / `missed` / `unexpected` against
`requiredCategories`/`metrics`/`scopes`/`severities` and `min`/`maxCount`, then
returns a fractional `score` (`detection-scorer.ts:73`):

```ts
const score = requirementCount === 0 ? 1
  : Math.max(0, (requirementCount - failedCount) / requirementCount);
return { ok: issues.length === 0, score, matched, missed, unexpected, issues };
```

This is the rung for the anomaly-monitoring agent: you don't care that it returned
anomalies in a specific order, only that it caught the revenue drop (a required
metric+scope) and didn't flood you with noise (`maxCount`). It's looser than exact
match, still pure and deterministic.

```
  Rung 2 — set membership over detections

  detections[] ─► required {category, metric, scope, severity} + min/maxCount
                                │
                                ▼
              { ok, score, matched[], missed[], unexpected[] }
```

**Rung 3 — ranked retrieval (`precision-at-k.ts`).** When the output is an
*ordered list* — search results — you score the top of the list.
`scorePrecisionAtK` counts distinct relevant ids in the top-k over the window size
(`precision-at-k.ts:47`):

```ts
export function scorePrecisionAtK(retrievedIds, relevantIds, k): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = Math.min(k, retrievedIds.length);   // short list isn't penalised
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}
```

Read the `ok` semantics carefully (`precision-at-k.ts:1`): `ok` means
**well-formed**, *not* "good." A perfectly valid score of `0.0` still has `ok:
true`; `ok` is only `false` when the metric is undefined (`k <= 0`, empty
retrieval). That separation — "did the computation make sense" vs "was the result
good" — is the subtle part. Studio's RAG page scores a fixed corpus this way, and
buffr grades `/Users/rein/Public/buffr/eval/queries.json` with the same metric.

```
  Rung 3 — precision@k over a ranked list

  retrievedIds[top-k] ∩ relevantIds  ──►  matched / min(k, retrieved)
                                            │
                                            ▼
                          { ok:well-formed, score, matched, total }
              ok:false ONLY when k<=0 or nothing retrieved (NOT when score is low)
```

**Rung 4 — rubric / LLM-as-judge (`rubric-judge.ts`).** The top rung, for outputs
only a reader can grade — a free-form answer, a recommendation's quality.
`RubricJudge.judge` calls a model via `generateStructured` to score the subject
against a `RubricDefinition` and returns per-dimension scores, a verdict, and one
fix (`rubric-judge.ts:89`). It's async, costs tokens, and is non-deterministic —
which is why it's the last rung, and why it has its own failure modes
(`03-llm-as-judge-bias.md`).

```
  Rung 4 — a model scores meaning

  subject + rubric ─► generateStructured ─► { dimensions:{score,reason}, verdict, fix }
                          │ model call (async, costs tokens, fuzzy)
                          ▼
                  validated against the rubric's own score ranges
```

### Move 3 — the principle

Climb the ladder only as far as the output forces you to. A fixed-shape artifact?
Structural rules — free and exact. A set of findings? Detection scoring. A ranked
list? precision@k. Free-form prose where meaning is the thing? Only then the LLM
judge. The win is twofold: cheap rungs are deterministic so they never flake, and
reserving the judge for prose keeps your eval suite fast and your token bill near
zero. The shared `{ok, ...}` shape means a test reads identically regardless of
which rung produced it.

## Primary diagram

```
  The eval-method ladder — mapped to aptkit's real scorers

  output type            rung                       module                cost
  ───────────────────────────────────────────────────────────────────────────
  fixed JSON shape   ►   exact / structural rules   structural-diff.ts    free, exact
  set of findings    ►   detection scoring          detection-scorer.ts   free, exact
  ranked list        ►   precision@k / recall@k     precision-at-k.ts     free, exact
  free-form prose    ►   rubric / LLM-as-judge      rubric-judge.ts       tokens, fuzzy
  anything           ►   human review               (not automated)       slowest

  shared seam: every scorer returns { ok, issues } or { ok, score, ... }
  rule: pick the LOWEST rung that distinguishes pass from fail
```

## Elaborate

The field calls these "exact match," "metrics-based," and "model-graded" evals;
aptkit's four modules are one concrete scorer per band, plus human at the top. The
detail that separates someone who's *used* these from someone who's read about
them is the `ok`-vs-`score` distinction in `precision-at-k.ts`: conflating
"well-formed" with "good" is the classic bug that makes an eval silently pass when
retrieval returns nothing. aptkit's comment spells it out — `ok:false` only on an
undefined metric, never on a low score. The other detail is `number` tolerance in
`structural-diff.ts`: exact-matching a float is how you get a flaky eval, so the
strict rung still has a knob for the real world. Read `01-eval-set-types.md` for
*what* you score against, and `03-llm-as-judge-bias.md` for why the top rung is the
one to distrust.

## Project exercises

### Add a precision@k regression test from the buffr eval set
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a test that loads `/Users/rein/Public/buffr/eval/queries.json`,
  runs each query through buffr's retrieval, scores with `scorePrecisionAtK`, and
  asserts the mean precision@k stays above a frozen threshold — turning the 3-doc
  relevance set into a guarded regression check.
- **Why it earns its place:** it connects a real relevance set to the actual
  scorer and demonstrates the `ok`(well-formed) vs `score`(quality) distinction in
  a real assertion.
- **Files to touch:** buffr retrieval test dir, reading
  `/Users/rein/Public/buffr/eval/queries.json` and
  `packages/evals/src/precision-at-k.ts`.
- **Done when:** the test passes at current retrieval quality and fails if a
  relevant doc drops out of the top-k.
- **Estimated effort:** `1–4hr`

### Add a `number`-tolerance assertion to the monitoring eval
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** in the anomaly-monitoring tests, assert a detected anomaly's
  `change.value` matches the expected magnitude within a tolerance using a
  `structural-diff` `number` rule, instead of an exact equals — so a float that
  drifts in the last digit doesn't flake the suite.
- **Why it earns its place:** it shows you know that exact-matching floats is a
  flakiness source and that the strict rung still needs a tolerance knob.
- **Files to touch:** `packages/agents/anomaly-monitoring/test/`, reading
  `packages/evals/src/structural-diff.ts`.
- **Done when:** the test passes at the recorded value and at value ± tolerance,
  and fails outside it.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "How do you decide how to score an eval?"**
By output type, on a cost ladder. Fixed-shape JSON gets exact structural rules —
free and deterministic. A set of findings gets detection scoring
(matched/missed/unexpected). A ranked list gets precision@k. Only free-form prose,
where meaning is the thing, goes to the LLM judge — because it's slow, costs
tokens, and is itself fallible. I climb the ladder only as far as the output
forces me to, so most of my suite is deterministic and fast.

```
  fixed shape → structural-diff   set → detection-scorer
  ranked list → precision@k       prose → rubric-judge (last resort)
```
Anchor: *pick the cheapest rung that distinguishes pass from fail.*

**Q: "Your precision@k returns ok:true on a score of zero. Bug?"**
No — deliberate. `ok` means the metric is *well-formed*, not that the result is
good. A valid retrieval that found nothing relevant has a true, well-defined score
of 0.0, so `ok:true, score:0`. `ok` is only `false` when the metric is undefined —
`k <= 0` or an empty retrieval set, where the denominator would be zero.
Conflating the two is how an eval silently passes when retrieval returns nothing.

```
  ok = "computation made sense"   score = "how good"
  ok:false ONLY on k<=0 / empty retrieval, never on a low score
```
Anchor: *separate "well-formed" from "good" — conflating them hides the worst failure.*

## See also

- `01-eval-set-types.md` — what you score against
- `03-llm-as-judge-bias.md` — why the top rung is the one to distrust
- `03-retrieval-and-rag/11-rag.md` — the retrieval that precision@k scores
- `04-llm-observability.md` — the artifact `assertReplayArtifactShape` checks
