# Structural shape assertions (rule-based structural diff)

**Industry names:** schema/shape assertion · structural diff · contract assertion on
semi-structured output. **Type:** Project-specific (a hand-rolled rule engine).

## Zoom out, then zoom in

```
  Zoom out — where shape assertions sit

  ┌─ Test / eval driver ─────────────────────────────────────┐
  │  node --test  ·  eval:replays  ·  replay-fixture           │
  └─────────────────────────────┬─────────────────────────────┘
                                │ feeds LLM output (JSON-ish)
  ┌─ Eval layer (packages/evals) ▼────────────────────────────┐
  │  assertions.ts ── builds rule lists ──► structural-diff.ts │ ← ★ here ★
  │  assertRecommendationShape / assertAnomalyShape / …        │
  │  evaluateStructuralDiff(value, rules) → { ok, issues[] }   │
  └─────────────────────────────┬─────────────────────────────┘
                                │ result drives
  ┌─ Verdict ───────────────────▼─────────────────────────────┐
  │  red/green  ·  promotable?  ·  embedded artifact eval.ok    │
  └────────────────────────────────────────────────────────────┘
```

You can't write `assert.equal(answer, "Revenue in SP fell because...")` against an
LLM — the exact words drift every run. But you *can* assert the answer is a string,
is at least 20 chars, and mentions "BRL 285,500". That's the move: **assert the
shape and the load-bearing facts, not the exact bytes.** AptKit hand-rolled a small
rule engine to do it — `evaluateStructuralDiff` — instead of reaching for a JSON
schema library, because the rules it needs (numeric tolerance, array-includes by
sub-path, contains-text) are awkward in plain JSON Schema.

## Structure pass

**Layers:** typed assertion helper (`assertRecommendationShape`) → generic rule
evaluator (`evaluateStructuralDiff`) → path resolver (`getPath`).

**Axis — strictness (how exact is the check?):** trace it down.

```
  One question down the layers: "how exact is this check?"

  ┌─ assertRecommendationShape ──┐  semantic: "is this a valid recommendation?"
  └──────────────┬───────────────┘
  ┌─ evaluateStructuralDiff ─────▼┐  structural: "do these 6 rules hold?"
  └──────────────┬────────────────┘
  ┌─ getPath ────▼────────────────┐  mechanical: "does '0.steps' resolve?"
  └────────────────────────────────┘
```

**The seam:** between the *typed* helpers and the *generic* evaluator. Above the
seam you name a capability ("recommendation shape"); below it you have anonymous
rules over paths. The seam is load-bearing because it's where domain meaning
(strictness changes from "valid recommendation" to "path exists") flips — and it's
the reuse point: every capability's assertion is just a different rule list fed to
the same evaluator.

## How it works

### Move 1 — the mental model

Think of a list-render with a `key` prop: you don't assert the whole list equals a
fixed array, you assert each item *has the fields you render*. Same here — a rule
list says "these paths must exist, this array must have 1–3 items, this text must
contain X," and the evaluator walks the rules collecting every violation.

```
  The rule loop — collect ALL issues, don't bail on first

  rules: [ required '0.title', arrayCount min 2, containsText 'voucher' ]
            │              │                    │
            ▼              ▼                    ▼
  for each rule → resolve path → check → push issue if fail
            │
            ▼
  result = { ok: issues.length === 0, issues: [...all violations...] }
```

The strategy: **declarative rules over a value, evaluated independently, with every
failure reported** — so one run tells you everything that's wrong, not just the
first thing.

### Move 2 — step by step

**The path resolver — `getPath`.** Splits `'0.steps'` on `.`, walks the value part
by part, handling arrays (numeric index) and objects (key lookup), returning
`{ exists, value }`. The `exists` flag is the trick: it distinguishes "path missing"
from "path present but value is `undefined`."

```
  getPath('0.title', [{ title: 'X' }])

  parts: ['0', '1=title']
  current = [{title:'X'}]
    part '0'  → array, index 0  → current = {title:'X'}
    part 'title' → object key   → current = 'X'
  → { exists: true, value: 'X' }
```

Boundary: an out-of-range index or a missing key returns `{ exists: false }` and the
walk stops — so `'5.title'` on a 2-item array fails clean, no throw.

**The rule types — six of them.** `required`, `equals`, `number` (with tolerance),
`arrayCount` (exact/min/max), `containsText` (case-insensitive, recursive text
collection), `arrayIncludes` (by optional sub-path). The `number` tolerance and
`containsText` recursion are the LLM-specific ones: a model's number might be 10.2
when you expect 10, and you want a tolerance; a model's text is nested in objects,
so `collectText` flattens all strings before the substring check.

```
  Two rule checks side by side

  number, expected 10, tolerance 0.25, actual 10.2
    |10.2 - 10| = 0.2  ≤ 0.25  → PASS

  containsText 'voucher demand', value = nested object
    collectText(value) = "revenue in sp decreased after voucher demand dropped"
    haystack.includes('voucher demand') → PASS
```

**The typed helpers — naming the rule lists.** `assertRecommendationShape`
(`assertions.ts:7`) is just `assertRequiredPaths(output, ['0.title', '0.rationale',
...])` with a name attached. `assertReplayArtifactShape` is bigger: required paths
*plus* hand-written checks (schemaVersion === 1, ISO timestamp, non-negative
durationMs) *plus* a recursive secret scan. The helper is where "valid
recommendation" becomes a concrete rule list.

**The secret scan — a security check riding the shape assertion.**
`findSecretLikeString` (`assertions.ts:397`) recursively walks the whole artifact
looking for `sk-...` keys or `OPENAI_API_KEY=`. It's bundled into the artifact-shape
assertion so a promotable artifact is *also* proven free of leaked secrets. One
assertion, two guarantees.

### Move 3 — the principle

When the output is non-deterministic in its words but deterministic in its
*structure*, assert the structure and the load-bearing facts. The skill is choosing
which facts are load-bearing: a recommendation must have a `title` and `steps`
(structure) and might need to mention a specific feature (fact) — but its prose
phrasing is free to vary.

## Primary diagram

```
  Structural shape assertion — full picture

  LLM output (JSON-ish, words vary)
        │
        ▼
  assertRecommendationShape(output)          ← name the capability
        │  builds rule list
        ▼
  evaluateStructuralDiff(output, [           ← generic evaluator
    required '0.title', required '0.steps',
    arrayCount min 1, containsText 'scenario'
  ])
        │  per rule: getPath → check → maybe push issue
        ▼
  { ok: issues.length===0, issues: [{path, message}, ...] }
        │
        ├─ ok      → green / promotable / artifact.eval.ok = true
        └─ !ok     → red, with every violating path named
```

## Implementation in codebase

**Use cases:**
1. Agent output validation in fixture replay — `assertRecommendationShape` runs on
   the agent's output (`packages/agents/recommendation/scripts/replay-fixture.ts:53`).
2. Artifact promotion gate — `assertReplayArtifactShape` must pass before an
   artifact can become a fixture (`scripts/promote-replay-to-fixture.mjs:34`).
3. Batch eval — `assertCapabilityReplayArtifactShape` dispatches by capability and
   validates every saved artifact (`packages/evals/src/replay-runner.ts:48`).

**Code side by side — the generic evaluator core**
(`packages/evals/src/structural-diff.ts`):

```
  packages/evals/src/structural-diff.ts  (lines 20–47)

  export function evaluateStructuralDiff(value, rules) {
    const issues = [];
    for (const rule of rules) {              ← every rule, independently
      switch (rule.type) {
        case 'required':   assertRequiredRule(value, rule, issues); break;
        case 'number':     assertNumberRule(value, rule, issues);   break;
        case 'arrayCount': assertArrayCountRule(value, rule, issues);break;
        ... // equals, containsText, arrayIncludes
      }
    }
    return { ok: issues.length === 0, issues }; ← ALL violations, not first
  }
        │
        └─ collecting every issue (not throwing on first) means one test run
           reports the full diff — the "structural diff" name (load-bearing)
```

**Code side by side — the failure-path test that pins this behavior**
(`packages/evals/test/structural-diff.test.ts`):

```
  packages/evals/test/structural-diff.test.ts  (lines 43–61)

  const result = evaluateStructuralDiff(subject, [
    { type: 'required', path: 'missing.value' },     ← 6 rules, all designed to fail
    { type: 'equals', path: 'id', expected: 'other' },
    { type: 'number', path: 'score', expected: 20, tolerance: 1 },
    ...
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(i => i.path), [  ← asserts the EXACT path list
    'missing.value', 'id', 'score',
    'recommendations', 'answer', 'recommendations.bloomreachFeature',
  ]);
        │
        └─ this test proves the evaluator reports every failing path in order —
           if someone changed it to bail on first failure, this goes red
```

## Elaborate

This is a hand-rolled alternative to JSON Schema / Zod / Ajv. The deliberate choice:
the rules AptKit needs — numeric tolerance, `arrayIncludes` by sub-path,
case-insensitive recursive `containsText` — are clumsy or impossible in declarative
JSON Schema and would need custom keywords anyway. A 200-line rule engine that the
team owns beats fighting a schema validator's extension API. The cost: it's bespoke,
so a new contributor learns AptKit's rule vocabulary instead of a standard one.
Accepted, because the eval seam is small and central.

Where it connects: these assertions consume the replayed output from
`01-replay-as-test.md`, gate the promotion in `03-promote-to-fixture-baseline.md`,
and sit one notch stricter than the fractional scoring in `04-detection-scoring.md`
(shape = pass/fail; detection = degree).

## Interview defense

**Q: How do you assert on LLM JSON output without pinning the exact text?**
> Assert shape + load-bearing facts, not bytes. A rule list: required paths exist,
> arrays have the right count, key text appears, numbers within tolerance. Run all
> rules, collect every violation, fail if any.

```
  output ─► [required, arrayCount, containsText, number±tol] ─► {ok, issues[]}
```
> Anchor: the words drift; the structure doesn't. Pin the structure.

**Q: Why not JSON Schema?**
> The needed rules — numeric tolerance, array-includes-by-subpath, recursive
> contains-text — are awkward in JSON Schema and need custom keywords anyway. A
> small owned rule engine is clearer than fighting the validator. Trade-off: it's
> bespoke vocabulary, not a standard.

## Validate

1. **Reconstruct:** write `getPath` from memory — split on `.`, walk arrays by index
   and objects by key, return `{exists, value}`. Check `structural-diff.ts:53`.
2. **Explain:** why does `evaluateStructuralDiff` collect all issues instead of
   throwing on the first failure? (`structural-diff.test.ts:43` depends on it.)
3. **Apply:** the recommendation model starts returning `estimatedImpact` as a
   string instead of an object. Which assertion catches it, and what `issues[].path`
   do you get? (`assertRecommendationShape` requires `0.estimatedImpact`,
   `assertions.ts:13`.)
4. **Defend:** why is the secret scan (`assertions.ts:397`) bundled into the
   artifact-shape assertion rather than run separately?

## See also

- `01-replay-as-test.md` — produces the output these assertions check.
- `03-promote-to-fixture-baseline.md` — uses `assertReplayArtifactShape` as the gate.
- `04-detection-scoring.md` — the fractional-score sibling.
- `audit.md` lens 5 (edge cases) and lens 6 (testing AI features).
