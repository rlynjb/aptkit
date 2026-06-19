# Eval methods — the scoring ladder

**Industry names:** exact match, fuzzy/structural match, rubric scoring, LLM-as-judge, pairwise preference, human eval · *Industry standard*

## Zoom out, then zoom in

You have an output and a question: *is it good?* The honest answer depends on
how cheaply you can decide. AptKit doesn't pick one method — it stacks them, and
the `@aptkit/evals` package is the rung-by-rung implementation. Here's where the
methods sit relative to the outputs they score.

```
  Zoom out — where eval methods sit

  ┌─ Outputs under test (from agents) ──────────────────────────────┐
  │  recommendations · anomalies · diagnoses · query answers        │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  scored by one (or more) rungs
  ┌─ Method ladder (@aptkit/evals) ─▼───────────────────────────────┐
  │  exact      structural-diff.ts   (cheap, deterministic)         │
  │  fuzzy/     detection-scorer.ts  ← ★ precision/recall-style ★   │ ← we are here
  │  precision  rubric-judge.ts      (LLM-as-judge, see 03)          │
  │  LLM-judge  [pairwise — NOT shipped]                            │
  │  human      [review gate before promotion — see 01]            │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: you already grade things on a ladder of effort without thinking about
it — `===` for a number, a regex for a string shape, a code reviewer for "is
this design any good." Eval methods are the same ladder, formalized. The rule is
**climb only as far as you must**: exact match is free and unambiguous but only
works when there's one right answer; an LLM judge handles open-ended quality but
is slow, costs tokens, and is itself biased (`03`). AptKit implements the bottom
three rungs concretely and leans on a human gate at the top.

## Structure pass

**Layers.** Two: the *deterministic rules* (structural diff, detection scoring —
pure functions over JSON, no model) and the *model-in-the-loop judgment* (the
rubric judge — calls an LLM to score). The boundary between them is the most
important line in the whole eval layer.

**Axis — cost and determinism: what does one judgment cost, and is it
repeatable?** Trace it up the ladder:

```
  One axis — "cost + determinism of a single judgment"

  exact match       →  free,  100% deterministic, only for one-right-answer
  structural diff   →  free,  deterministic, checks shape/content rules
  detection score   →  free,  deterministic, partial-credit precision/recall
  rubric / LLM-judge→  $$ + latency, NON-deterministic, handles open quality
  pairwise          →  $$ + latency, non-deterministic, relative not absolute
  human             →  $$$ + slow, the ground truth everything else approximates

  cost rises and determinism falls as you climb
```

**Seams.** The load-bearing seam is the **deterministic / model-in-the-loop
boundary** — the step from `detection-scorer.ts` to `rubric-judge.ts`. Below it,
a judgment is a pure function: same input, same score, zero cost, fully
auditable. Above it, a judgment is a model call: it costs tokens, it varies run
to run, and it can be *wrong about quality* in ways the rungs below cannot. Every
design decision in the eval layer is "can I stay below this seam?" Study it
first; `03` is entirely about defending the rung just above it.

## How it works

You know `assert.equal(actual, expected)` and you know "well, a human has to look
at this one." The method ladder is everything in between, ordered by how much
ambiguity each rung can absorb. Walk it bottom to top.

### Move 1 — the mental model

The ladder is a sequence of graders, each handling outputs the rung below can't.
You climb only when the cheaper rung can't decide.

```
  The method ladder — climb only when forced

         human review            ◄── ground truth (slow, $$$)
              ▲
         pairwise preference     ◄── "A or B?" (relative)
              ▲
         LLM-as-judge (rubric)   ◄── "score this against a rubric"
   ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─  the model-in-the-loop seam
              ▲
         detection score         ◄── partial credit: matched/missed/unexpected
              ▲
         structural diff         ◄── shape + must-have content rules
              ▲
         exact match             ◄── one right answer, byte-equal
```

The trap is reaching for the LLM judge first because it feels powerful. It's the
*most* expensive, *least* repeatable rung. Most of what you want to know — "did
the output have the required fields? did the monitor flag the right category? is
the answer long enough to be useful?" — is answerable for free, deterministically,
below the seam.

### Move 2 — the step-by-step walkthrough

#### Rung 1-2 — structural diff (exact + fuzzy shape rules)

Start where unit testing starts: assert the output has the right shape. AptKit's
`evaluateStructuralDiff` is a small rule engine over arbitrary JSON. Each rule
targets a dot-path and reports a `StructuralIssue` if it fails; zero issues means
pass.

```
  Structural diff — six rule types over JSON dot-paths

  value ──► for each rule, walk the path and check:
     ├─ required      path exists at all
     ├─ equals        path === expected (deep)            ← exact-match rung
     ├─ number        |path - expected| <= tolerance       ← fuzzy numeric
     ├─ arrayCount    array length exact / min / max
     ├─ containsText  flattened text under path includes "needle"  ← fuzzy text
     └─ arrayIncludes some item (or item.itemPath) deepEquals value

  issues = []  → ok: true     issues = [..] → ok: false, here's where
```

The two interesting rungs hide here. `equals` is the *exact-match* rung — full
deterministic equality, used when there genuinely is one right value.
`containsText` is the *fuzzy-text* rung — it flattens the whole subtree under a
path into one string and checks for a substring (case-insensitive by default),
so "the diagnosis mentions checkout" passes whether the model says it in
sentence three or paragraph two. `number` with a `tolerance` is *fuzzy numeric* —
"about 1500, give or take 50." The boundary condition: `getPath` returns
`{exists: false}` for a missing path, and most rules treat missing-path as a
failure, so a typo'd path silently fails the rule rather than throwing. Read your
issues.

#### Rung 3 — detection scoring (partial credit, precision/recall-style)

Structural diff is pass/fail. But "the anomaly monitor flagged 4 of the 5
categories it should have" isn't pass/fail — it's *partial credit*. That's what
`scoreDetections` adds: a precision/recall-style score over a list of detections
against a set of expectations.

```
  scoreDetections — turn expectations into a 0..1 score

  expectations:  requiredCategories, requiredMetrics, requiredScopes,
                 requiredSeverities, minCount, maxCount
        │
        ▼ flatten each required value into one "requirement"
  requirements = [category:checkout, metric:revenue, severity:high, …]
        │
        ▼ for each requirement, does ANY detection match it?
  matched = [category:checkout, …]      missed = [severity:high]
        │
        ▼ also: count violations (too few / too many detections)
        ▼ also: unexpected = categories present but NOT in requiredCategories
        │
        ▼ score = (requirementCount - failedCount) / requirementCount
```

The score is the recall-flavored heart of it. `requirementCount` is the total
number of things you required (every required category/metric/scope/severity,
plus one each if `minCount`/`maxCount` were set). `failedCount` is how many of
those went unmet (missed requirements plus count violations). The score is
`(requirementCount - failedCount) / requirementCount`, floored at 0, and 1 when
nothing was required. So requiring 5 categories and matching 4 yields 0.8 — a
graded signal a pass/fail rule can't give you. The boundary condition: `ok` is
`true` only when there are *zero* issues, so `ok` and `score === 1` move
together, but a partial run reports `ok: false` *and* a meaningful 0.8 you can
threshold on. `unexpected` (categories you didn't ask for) is reported but does
*not* lower the score — it's a precision *signal*, not a penalty. That's a
deliberate design choice, and a thing to flag in review.

#### The seam — crossing into model-in-the-loop

Everything above is a pure function: free, deterministic, auditable. The moment a
rule can't be written — "is this recommendation *actually well-reasoned*?", "is
this answer *clear*?" — you cross the seam into an LLM judge. You pay tokens, you
lose determinism, and you inherit bias. Cross it only for genuinely open-ended
quality.

```
  The seam — what changes when you cross it

  BELOW (structural-diff, detection-scorer)   ABOVE (rubric-judge)
  ─────────────────────────────────────────   ─────────────────────────
  pure function over JSON                      model.complete() call
  $0, deterministic, same score every run      tokens + latency, varies
  auditable: "failed because path X missing"   auditable only via the
                                               judge's per-dimension reasons
  can't judge open-ended quality               that's the whole point
```

#### Rung 4 — LLM-as-judge (rubric scoring)

Above the seam, AptKit ships `RubricJudge`: a model call constrained by a
*rubric contract* so it scores against declared dimensions and returns
structured `{score, reason}` per dimension plus a verdict and one fix. The
mechanics of *why the contract matters* — bias defense — are the entire subject
of [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md). For the ladder, the point
is: this rung handles what no deterministic rule can, at the cost of everything
the seam diagram lists.

#### Rungs 5-6 — pairwise and human

Two rungs AptKit doesn't fully ship. **Pairwise preference** ("is answer A or B
better?") is often more reliable than absolute scoring because relative judgments
are easier — AptKit has no pairwise comparator. **Human review** is the ground
truth all the rungs below approximate; in AptKit it appears as the *review gate
before promoting a replay artifact into a regression fixture* (`01`). Naming what
isn't built is part of the method: AptKit's automated ladder tops out at the
rubric judge.

### Move 3 — the principle

A grader's value is `(ambiguity it can absorb) / (cost per judgment)`. Exact
match absorbs zero ambiguity at zero cost; a human absorbs all of it at maximum
cost. The engineering is to push as much of your eval as possible *down* the
ladder — write the structural rule, compute the partial-credit score — and spend
the expensive model-in-the-loop rung only on the residue that genuinely needs
judgment. A test suite that LLM-judges things `===` could have caught is paying
rent on ambiguity it doesn't have.

## Primary diagram

The full ladder with AptKit's implementation on each rung and the deterministic
seam marked.

```
  AptKit's eval method ladder — implementation per rung

  ┌─ rung 6  HUMAN ─────────────────────────────────────────────────┐
  │  review gate before promotion (scripts/promote-…, see 01)        │
  ├─ rung 5  PAIRWISE ──────────────────────────────────────────────┤
  │  [NOT shipped — no comparator]                                   │
  ├─ rung 4  LLM-AS-JUDGE ──────────────────────────────────────────┤
  │  RubricJudge.judge() → {dimensions:{score,reason}, verdict, fix} │
  │  packages/evals/src/rubric-judge.ts                              │
  ╞═════════════ model-in-the-loop seam (tokens, non-determinism) ═══╡
  │  rung 3  DETECTION SCORE                                          │
  │  scoreDetections() → score = (req - failed)/req, partial credit  │
  │  packages/evals/src/detection-scorer.ts                          │
  ├─ rung 2  STRUCTURAL / FUZZY ────────────────────────────────────┤
  │  evaluateStructuralDiff() — required/number/arrayCount/          │
  │  containsText/arrayIncludes   packages/evals/src/structural-diff.ts│
  ├─ rung 1  EXACT MATCH ───────────────────────────────────────────┤
  │  the `equals` rule (deep equality)                               │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The recommendation eval asserts shape with structural rules
(`assertRecommendationShape` → `assertRequiredPaths`). The anomaly monitor's
behavioral eval scores its detections with partial credit — Studio's
`assertMonitoringBehavioralExpectations` calls `scoreDetections` with the
fixture's required categories/metrics/scopes/severities. The diagnostic eval uses
`containsText` to assert the conclusion mentions required evidence text. The
rubric judge (rung 4) drives the rubric-improvement agent (`03`).

**Rung 2 — the structural rule engine**, `packages/evals/src/structural-diff.ts:20-47`:

```
  packages/evals/src/structural-diff.ts  (lines 20-47)

  export function evaluateStructuralDiff(value, rules) {
    const issues = [];
    for (const rule of rules) {
      switch (rule.type) {
        case 'required':     assertRequiredRule(value, rule, issues); break;
        case 'equals':       assertEqualsRule(value, rule, issues); break;   ← exact
        case 'number':       assertNumberRule(value, rule, issues); break;   ← fuzzy num
        case 'arrayCount':   assertArrayCountRule(value, rule, issues); break;
        case 'containsText': assertContainsTextRule(value, rule, issues); break; ← fuzzy text
        case 'arrayIncludes':assertArrayIncludesRule(value, rule, issues); break;
      }
    }
    return { ok: issues.length === 0, issues };  ← pass = ZERO issues
  }
       │
       └─ a flat rule list, one switch, issues accumulate. `ok` is derived,
          not asserted — so the issues array IS the failure explanation.
```

The `containsText` rung is worth seeing because the flattening is the fuzzy part,
`packages/evals/src/structural-diff.ts:185-192`:

```
  packages/evals/src/structural-diff.ts  (lines 185-192)

  function collectText(value, normalize) {
    if (typeof value === 'string') return normalize ? value.toLowerCase() : value;
    if (Array.isArray(value)) return value.map(v => collectText(v, normalize)).join('\n');
    if (value && typeof value === 'object')
      return Object.values(value).map(v => collectText(v, normalize)).join('\n');
    return '';
  }
       │
       └─ recursively flattens an ENTIRE subtree into one string, then the
          rule does a substring check. That's why "mentions checkout" passes
          no matter where in the structure the word appears — fuzzy by design.
```

**Rung 3 — the partial-credit score**, `packages/evals/src/detection-scorer.ts:71-73`:

```
  packages/evals/src/detection-scorer.ts  (lines 71-73)

  const requirementCount =
    required.length + (minCount > 0 ? 1 : 0) + (maxCount !== undefined ? 1 : 0);
  const failedCount =
    missed.length + issues.filter(i =>
      i.path === 'expectations.minCount' || i.path === 'expectations.maxCount').length;
  const score = requirementCount === 0
    ? 1
    : Math.max(0, (requirementCount - failedCount) / requirementCount);
       │
       └─ THE formula. Each required category/metric/scope/severity is one
          requirement; min/maxCount each add one if set. score is the fraction
          met, floored at 0, and 1 when nothing was required. This is what
          turns "4 of 5 categories" into 0.8 instead of a flat fail.
```

It's wired up in `apps/studio/vite.config.ts:1198-1206`, where the monitoring
behavioral eval passes the fixture's expectations straight into `scoreDetections`.

## Elaborate

The ladder is folklore made explicit. Exact match and structural assertions come
straight from unit testing. Precision/recall — what `scoreDetections` approximates
— is the classic information-retrieval pair: of what you flagged, how much was
right (precision); of what you should have flagged, how much did you catch
(recall). AptKit's score is recall-leaning: it divides met requirements by total
*required*, so it answers "how much of what mattered did you catch," and treats
`unexpected` (a precision signal) as reportable-but-unpenalized. LLM-as-judge and
pairwise preference come from the RLHF/eval-harness lineage (e.g. MT-Bench,
Chatbot Arena) where open-ended quality has no programmable oracle.

The deep idea is the seam: deterministic graders are *oracles* (they know the
answer), model graders are *approximators* (they estimate it and can be wrong).
Every rung you can keep below the seam is a rung that never lies to you. That's
why `03` exists — once you're forced above the seam, you have to actively defend
against the judge being wrong.

Adjacent: the sets these methods score
([01-eval-set-types.md](01-eval-set-types.md)); the bias defense for rung 4
([03-llm-as-judge-bias.md](03-llm-as-judge-bias.md)); the artifacts the replay
eval runs these methods over ([04-llm-observability.md](04-llm-observability.md)).

## Project exercises

*Provenance: Phase 5 — Evals and observability (C5.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the bottom three rungs exist;
these add a missing rung and a missing signal.*

### Exercise — add a pairwise-preference comparator (rung 5)

- **Exercise ID:** `[C5.3]` Phase 5, eval-methods concept, Case A (extend)
- **What to build:** A `comparePair(subjectA, subjectB, rubric, model)` function
  in `@aptkit/evals` that asks the model which of two outputs better satisfies a
  rubric and returns `{winner: 'A'|'B'|'tie', reason}`. Reuse the `RubricJudge`
  system-prompt scaffolding but produce a relative verdict instead of an absolute
  score. Defend against position bias by running it twice with A/B swapped and
  only declaring a winner if both orderings agree (otherwise `tie`).
- **Why it earns its place:** Pairwise is rung 5 and AptKit has no comparator —
  the highest missing rung on the automated ladder. The swap-and-agree trick is
  the textbook position-bias defense (see `03`), so the exercise connects two
  concepts.
- **Files to touch:** `packages/evals/src/pairwise-judge.ts` (new),
  `packages/evals/src/index.ts`, `packages/evals/test/pairwise-judge.test.ts`
  (use the fixture provider so it's deterministic).
- **Done when:** A test shows the comparator returns `tie` when the two orderings
  disagree and a stable winner when they agree.
- **Estimated effort:** `1-4hr`

### Exercise — report a precision signal in detection scoring

- **Exercise ID:** `[C5.4]` Phase 5, eval-methods concept
- **What to build:** Extend `DetectionScoreResult` with a `precision` field
  computed from `unexpected` (detections not in `requiredCategories`) so the
  score reports both recall (the existing fraction) and precision (matched /
  (matched + unexpected)). Keep the existing `score` unchanged for compatibility.
- **Why it earns its place:** The current score is recall-only and silently
  ignores over-flagging — a monitor that flags every category scores 1.0 today.
  Adding the precision signal names that blind spot and completes the IR pair.
- **Files to touch:** `packages/evals/src/detection-scorer.ts`,
  `packages/evals/test/detection-scorer.test.ts`.
- **Done when:** A test with 3 required and 2 unexpected detections reports
  `score: 1` (recall) and `precision: 0.6`, and a no-over-flag case reports
  `precision: 1`.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: You need to eval an LLM feature. Where do you start — LLM-as-judge?**

```
  exact ─► structural ─► detection score ═seam═► LLM-judge ─► human
  free, deterministic                     │  $$, non-det, biased
  answer as much as you can BELOW the seam┘
```

"No — that's the most expensive, least repeatable rung. I start at the bottom:
can I assert this with a structural rule? In AptKit that's `evaluateStructuralDiff`
— required fields, `containsText` for must-have content, `number` with tolerance.
If it's a list-of-detections problem I want partial credit, so `scoreDetections`
— `(requirementCount - failedCount)/requirementCount`. I only cross the
model-in-the-loop seam to `RubricJudge` for genuinely open-ended quality, because
above that seam I pay tokens, lose determinism, and inherit bias I now have to
defend against."
*Anchor: push every judgment below the seam that can live there.*

**Q: The anomaly monitor caught 4 of 5 categories it should have. Pass or fail?**

```
  requirementCount = 5      failedCount = 1 (one missed)
  score = (5 - 1) / 5 = 0.8        ok = false (issues present)
```

"Both, depending on which field you read. `scoreDetections` reports `ok: false`
because there's an issue, *and* `score: 0.8` because 4 of 5 requirements were met
— `detection-scorer.ts:71-73`. That partial-credit number is the point: a flat
pass/fail throws away the signal that we're close. I'd threshold on the score, not
just `ok`, and note that `unexpected` detections are reported but don't lower the
score — so over-flagging is invisible to the current formula."
*Anchor: the score is recall-flavored partial credit, not a boolean.*

## Validate

- **Reconstruct:** From memory, write the `scoreDetections` formula and say what
  `requirementCount` and `failedCount` each count. Check against
  `packages/evals/src/detection-scorer.ts:71-73`.
- **Explain:** Why does `containsText` flatten the entire subtree into one string
  before checking (`structural-diff.ts:185-192`) rather than checking one field?
  (So "the output mentions X" passes regardless of where in the structure X
  appears — fuzzy text match, robust to the model moving content around.)
- **Apply:** A fixture requires 3 categories and the monitor returns those 3 plus
  2 categories you didn't require. What's the score, and is that the behavior you
  want? (Score is 1.0 — `unexpected` doesn't penalize. Whether that's right
  depends on whether over-flagging matters for your use case; if it does, the
  formula needs a precision term — exercise C5.4.) Trace
  `detection-scorer.ts:64-73`.
- **Defend:** Why keep the deterministic rungs at all instead of just using the
  rubric judge for everything? (The judge costs tokens, varies run-to-run, and
  can be wrong about quality; a `required`-field check is free, identical every
  run, and cannot be fooled. Every judgment kept below the seam is one that never
  lies. See the seam in `rubric-judge.ts` vs `structural-diff.ts`.)

## See also

- [01-eval-set-types.md](01-eval-set-types.md) — the sets these methods score
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — defending rung 4 against bias
- [04-llm-observability.md](04-llm-observability.md) — running these methods over replay artifacts
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the loop whose outputs get scored
- [../../study-prompt-engineering/05-eval-driven-iteration.md](../../study-prompt-engineering/05-eval-driven-iteration.md) — iterating prompts against these scores
