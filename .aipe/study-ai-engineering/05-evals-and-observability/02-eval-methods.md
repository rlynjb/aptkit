# Eval methods

> The cheap-to-expensive ladder (Industry standard)

Every eval method trades cost against the kind of "correct" it can judge. Cheap methods check shape and exact values — fast, deterministic, but blind to meaning. Expensive methods judge meaning with another model — flexible, but slow, costly, and biased. The pro move isn't picking one; it's running the cheap rungs first and only paying for the expensive ones when the cheap ones can't answer the question. aptkit has the whole ladder as real code, and the precision@k rung is the one genuine bridge to classical ML in the whole repo.

## Zoom out, then zoom in

Stack the four methods by cost. At the bottom, rule-based structural checks cost a JSON walk. Above that, the detection-scorer counts required categories. Above that, precision@k/recall@k compute a ranked-retrieval score — pure arithmetic, the same metric you'd use to grade any ranking system. At the top, the LLM-as-judge spends a whole model call to grade meaning.

```
The eval ladder — cost vs. what it can judge (LAYERS)

  ┌─────────────────────────────────────────────────────────────┐
  │ ★ LLM-AS-JUDGE   judges MEANING        $$$$  a model call     │  rubric-judge.ts
  │   "is this recommendation actually good?"  biased, scalable   │
  ├─────────────────────────────────────────────────────────────┤
  │   PRECISION@K / RECALL@K   ranked-retrieval quality   $       │  precision-at-k.ts
  │   "are the right docs in the top-k?"   the ML bridge          │  ← arithmetic
  ├─────────────────────────────────────────────────────────────┤
  │   DETECTION-SCORER   required categories/metrics      ¢       │  detection-scorer.ts
  │   "did the monitor flag the anomalies it had to?"            │
  ├─────────────────────────────────────────────────────────────┤
  │   STRUCTURAL-DIFF   shape + exact values   (cheapest)  ~0     │  structural-diff.ts
  │   "is the JSON well-formed with the right fields?"           │
  └─────────────────────────────────────────────────────────────┘
        run bottom-up; stop as soon as a rung answers "no"
```

The discipline is bottom-up: a malformed JSON fails the cheapest rung, so you never waste a model call judging garbage. The ★ rung is the only one that can judge "good," and it's the only one that can lie to you.

## Structure pass

One axis: **what counts as the ground truth the method compares against**.

- **Structural-diff** — ground truth is a *rule list* (`required`/`equals`/`number`/`arrayCount`/`containsText`/`arrayIncludes`). Deterministic, no model. `packages/evals/src/structural-diff.ts`.
- **Detection-scorer** — ground truth is a *set of expectations* (required categories, metrics, min/max count). Still deterministic. `packages/evals/src/detection-scorer.ts`.
- **precision@k / recall@k** — ground truth is a *relevant-id set*. The score is `matched / total` arithmetic over the top-k window. `packages/evals/src/precision-at-k.ts`.
- **LLM-as-judge** — ground truth is a *rubric*, and the comparison is done by a model. `packages/evals/src/rubric-judge.ts`.

The seam is uniform: every scorer returns an `ok` flag plus structured detail (`issues`, or `{score, matched, total}`), so the harness treats them interchangeably regardless of cost.

## How it works

**Move 1 — the mental model.** Picture a funnel. Cheap rules at the wide top reject obviously-wrong outputs for free. Only the survivors reach the expensive judge at the narrow bottom. You spend model-call dollars only on outputs that already passed the free checks.

```
The cheap-to-expensive funnel (PATTERN)

  candidate output
        │
        ▼  structural-diff  (free)   ── malformed? reject here
        │
        ▼  detection-scorer (¢)      ── missing required category? reject
        │
        ▼  precision@k     ($)        ── wrong docs ranked? score it
        │
        ▼  rubric-judge    ($$$$)     ── only well-formed, on-topic outputs
        ▼                                get the expensive meaning-check
  graded
```

**Move 2 — walk the rungs.**

**Rung 1 — structural-diff judges shape for free.** A rule list runs over the JSON; any violation becomes an issue.

```
structural-diff.ts (20-47)                   what it checks
  for (const rule of rules) {          ─────  apply each rule
    switch (rule.type) { required/      ────  field present?
      equals/number/arrayCount/         ────  value matches?
      containsText/arrayIncludes }      ────  array shape?
  }
  return { ok: issues.length === 0,     ─────  ok = zero violations
           issues };
```

`packages/evals/src/structural-diff.ts:46` returns `{ ok: issues.length === 0, issues }`. No model, no network — this is the rung you run first on everything.

**Rung 2 — detection-scorer grades coverage of required signals.** It counts how many required categories/metrics the output actually flagged.

```
detection-scorer.ts (73)                     the formula
  score = requirementCount === 0          ── nothing required → perfect
    ? 1
    : (requirementCount - failedCount)     ── fraction of requirements met
      / requirementCount
```

`packages/evals/src/detection-scorer.ts:73` is the score line; it also flags unexpected categories (65-69). This is how the anomaly-monitoring agent gets graded — did it catch the anomalies it was supposed to?

**Rung 3 — precision@k / recall@k: the ML bridge.** This is the rung worth memorizing, because it's the exact metric used to evaluate *any* ranking system — search, recommendations, RAG retrieval. The math is small and exact.

precision@k asks: *of the top-k I returned, what fraction are relevant?* The subtle part is the denominator — it's `min(k, retrievedIds.length)`, so a short result list isn't unfairly punished.

```
scorePrecisionAtK — the walkthrough (precision-at-k.ts 47-57)

  retrievedIds = [d3, d7, d1, d9, d3]    relevantIds = {d1, d3, d8}    k = 3
                 └────top-3────┘
  top-3 window           = [d3, d7, d1]
  distinct relevant hits = {d3, d1}      → matched = 2   (27-34: dups count once)
  denominator            = min(3, 5) = 3 → total   = 3   (53)
  precision@3            = matched/total = 2/3 ≈ 0.67     (56)

  return { ok: true, score: matched/total, matched, total }   (56)
```

```
scoreRecallAtK — same hits, different denominator (precision-at-k.ts 68-78)

  matched = 2  (the SAME distinct top-k hits)
  total   = |relevantIds| = 3                 (74)
  recall@3 = matched/total = 2/3 ≈ 0.67       (77)
```

`packages/evals/src/precision-at-k.ts:55-56` is the precision return; `:74-77` is recall. The only difference between the two scorers is the denominator: precision divides by *how many you looked at* (`min(k, len)`), recall divides by *how many were relevant in total* (`|relevantIds|`). `countDistinctHits` (27-34) de-dupes — a relevant id appearing twice in the window counts as one hit, because you're measuring coverage, not frequency. And `ok` here means *well-formed*, not *good*: a perfectly valid score of 0 still returns `ok: true` (8). It's only `ok: false` when the metric is undefined — `k <= 0` or a zero denominator (52-54).

**Rung 4 — the LLM-as-judge (`RubricJudge`) grades meaning.** When you need "is this answer actually *good*," rules can't help — you spend a model call.

```
rubric-judge.ts (89-104)                     why it's the top rung
  judge(input) =>
    generateStructured({
      model: this.model,                ─────  the judge model is INJECTED (60)
      system: buildRubricJudgeSystemPrompt,    rubric → prompt (107-161)
      validate: createRubricJudgmentValidator  per-dimension bounds (170-224)
    })
```

`packages/evals/src/rubric-judge.ts:89-104` runs the judge. It's the most expensive and the only biased rung — covered in full in [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md).

**Move 3 — the principle.** Cost and judgeable-meaning move together. You can't get cheap *and* meaning. So you build the ladder, run it bottom-up, and let each rung reject what it can before paying for the next. The precision@k rung is special: it's cheap arithmetic that nonetheless judges a *real quality signal* (ranking), which is why it's the bridge between classical ML evaluation and LLM evaluation.

## Primary diagram

```
The four scorers, one uniform seam

  structural-diff   → { ok, issues }                deterministic, ~free
  detection-scorer  → { ok, score, matched, missed } deterministic, ¢
  precision@k       → { ok, score, matched, total }  arithmetic, $   ← ML bridge
  recall@k          → { ok, score, matched, total }  arithmetic, $
  rubric-judge      → { dimensions, verdict, fix }   model call, $$$$
                       │
                       └ all share an `ok`/score shape → harness treats them alike
```

## Elaborate

The `min(k, len)` denominator in precision@k is the detail interviewers probe. Naive precision@k divides by `k` always; if you asked for 5 and only 3 docs exist, dividing by 5 caps your best possible score at 0.6 even when all 3 are relevant. aptkit divides by `min(k, len) = 3`, so a perfect short list scores 1.0. That's the correct behavior and the kind of thing that signals you've actually implemented the metric.

Recall@k vs precision@k is the classic tension: raising `k` can only help recall (more chances to find the relevant ones) but tends to hurt precision (you're now including lower-ranked, likely-less-relevant docs). They share `countDistinctHits` as numerator and differ only in denominator — that symmetry is the cleanest way to remember them.

NDCG is the obvious missing rung — precision@k treats a relevant doc at rank 1 the same as one at rank 5. That's the Case A exercise below.

## Project exercises

### Add NDCG to the ranked-retrieval scorers

- **Exercise ID:** `EX-EVAL-02a`
- **What to build:** `scoreNDCGAtK(retrievedIds, relevanceById, k)` alongside the existing precision/recall scorers, returning the same `{ ok, score, ... }` shape. NDCG weights hits by rank (log discount), so a relevant doc at rank 1 scores higher than the same doc at rank 5 — capturing what precision@k throws away. This deepens the Phase 3 (evals) ranked-retrieval rung.
- **Why it earns its place:** precision@k is position-blind; NDCG is the industry-standard fix and the metric most search/recsys interviews expect. Adding it next to the existing scorers proves you understand *why* rank-weighting matters, not just the formula.
- **Files to touch:** `packages/evals/src/precision-at-k.ts` (or a sibling `ndcg.ts`); export from `packages/evals/src/`.
- **Done when:** two retrieval orderings with identical precision@k but different rankings produce different NDCG scores, and `ok: false` is returned for `k <= 0`.
- **Estimated effort:** `1–4hr`

### Wire the funnel ordering explicitly

- **Exercise ID:** `EX-EVAL-02b`
- **What to build:** A small harness that runs structural-diff → detection-scorer → precision@k → rubric-judge in order and short-circuits, skipping the model call when a cheaper rung already failed.
- **Why it earns its place:** It turns the conceptual ladder into enforced cost discipline — you never pay for a judge call on malformed output.
- **Files to touch:** new module in `packages/evals/src/`; compose the existing scorers.
- **Done when:** a malformed input is graded without any call to `RubricJudge.judge`.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why is precision@k's denominator `min(k, len)` and not just `k`?**

```
  asked for k=5, only 3 docs exist, all relevant
  / k       = 3/5 = 0.6   ← unfairly caps a perfect short list
  / min(k,len)=3/3 = 1.0   ← correct
```

Anchor: `precision-at-k.ts:53` — `total = Math.min(k, retrievedIds.length)`.

**Q: What's the difference between precision@k and recall@k in this code?**

Anchor: identical numerator (`countDistinctHits`, 27-34); precision divides by `min(k,len)` (53), recall by `|relevantIds|` (74). Same hits, different denominator.

**Q: When do you reach for the LLM-as-judge instead of a rule?**

```
  rules judge SHAPE+VALUES (free, exact)
  judge  judges MEANING ($$$$, fuzzy) ← only when no rule can express "good"
```

Anchor: `rubric-judge.ts:89-104` — run it last, only on outputs the cheap rungs already passed.

## See also

- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — the cost and the bias of the top rung.
- [01-eval-set-types.md](01-eval-set-types.md) — the sets these methods grade.
- [04-llm-observability.md](04-llm-observability.md) — where scores get recorded.
