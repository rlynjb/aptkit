# 03 — Rules-as-data validation (structural-diff)

**Industry names:** rules engine · data-driven validation · interpreter
pattern · specification-as-data.
**Type:** Language-agnostic design pattern.

---

## Zoom out, then zoom in

When AptKit checks whether an agent's output is *correct*, it doesn't run
hand-written `if` statements per capability. It runs a list of rule *objects*
through one engine.

```
  Zoom out — where structural-diff sits

  ┌─ Capabilities ─────────────────────────────────────────────┐
  │  agent run → output JSON (recommendations / diagnosis / ...) │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ the output is the value to check
  ┌─ Evals (building block) ──────▼─────────────────────────────┐
  │  ★ evaluateStructuralDiff(value, rules[]) ★                 │
  │  detection-scorer · rubric-judge · replay-runner            │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ feeds correctness baselines
  ┌─ Replay / fixtures ───────────▼─────────────────────────────┐
  │  artifacts/replays/*.json → promoted fixtures               │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is **rules-as-data**: the *what to check* is a data
structure (`StructuralDiffRule[]`), and the *how to check* is one engine that
walks the list. Many rule types — required, equals, number-with-tolerance,
array-count, contains-text, array-includes — hide behind a single `evaluate`
call. That's a deep module whose depth comes from breadth: one walk, six
strategies.

---

## Structure pass — layers · axis · seam

**Layers:** caller writes rules (data) → engine dispatches on `rule.type` →
per-rule asserter reads a path → `getPath` walks the value.

**Axis — trace "where does the validation *logic* live?"**

```
  one question: "where is the correctness logic encoded?"

  ┌──────────────────────────────────────┐
  │ caller: const rules = [...]           │  → in DATA. declarative.
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ evaluateStructuralDiff(switch)    │  → in DISPATCH. picks an asserter.
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ assertNumberRule, etc.        │  → in MECHANISM. the actual check.
          └──────────────────────────────┘

  the logic lives in the rule list, NOT in branching code → that's the win
```

**Seam:** the `StructuralDiffRule` union. On one side, callers compose rules
without knowing how any check runs; on the other, the engine adds a rule type
without any caller changing. The discriminated-union `type` field is the
contract — that's where the axis (declarative vs. imperative) flips.

---

## How it works

You know how a SQL `WHERE` clause is data you hand to an engine that figures
out how to satisfy it, rather than a loop you write by hand? Same shape here:
the rules are the query, `evaluateStructuralDiff` is the engine.

### Move 1 — the shape

```
  rules-as-data — one engine, a list of typed rule objects

  rules = [
    { type: 'required',   path: 'conclusion' },
    { type: 'arrayCount', path: 'evidence', min: 1 },
    { type: 'equals',     path: 'confidence', expected: 'high' },
  ]
        │
        ▼
  ┌─ evaluateStructuralDiff(value, rules) ─────────┐
  │  for each rule:  switch (rule.type) → asserter │
  │  asserter reads getPath(value, rule.path)      │
  │  push issue if it fails                         │
  └─────────────────────────────────────────────────┘
        │
        ▼
  { ok: issues.length === 0, issues: [...] }
```

### Move 2 — the parts

**The rule is a discriminated union — the `type` field drives everything.**
Each variant carries exactly the fields its check needs: `number` carries
`expected` + optional `tolerance`; `arrayCount` carries `exact`/`min`/`max`;
`containsText` carries `text` + `caseSensitive`. TypeScript's
`Extract<Rule, { type: 'number' }>` narrows each asserter to its own fields.
The boundary condition: add a rule type and you must add a `case` *and* an
asserter — the union makes the compiler force you to handle it.

**The engine is one loop and one switch.** `evaluateStructuralDiff` walks
rules, dispatches on `type`, and accumulates `StructuralIssue[]`. There is no
per-capability validation code — the recommendation agent and the diagnostic
agent run the *same* engine with *different* rule lists. That's the
collapse-M-call-sites payoff: every capability that needs "this field is
required, this array has ≥1 item" reuses one walk instead of writing its own.

```
  the dispatch — one switch, six strategies

  switch (rule.type) {
    'required'      → assertRequiredRule       (path exists?)
    'equals'        → assertEqualsRule         (deepEqual to expected?)
    'number'        → assertNumberRule         (within tolerance?)
    'arrayCount'    → assertArrayCountRule      (exact/min/max length?)
    'containsText'  → assertContainsTextRule    (substring, recursive collect?)
    'arrayIncludes' → assertArrayIncludesRule   (any item matches at itemPath?)
  }
       │
       └─ adding a rule type = one new case + one new asserter.
          callers' rule lists are untouched.
```

**`getPath` is the shared traversal — and it carries a hidden DSL.**
`getPath(value, 'evidence.0.source')` splits on `.`, and a numeric segment
indexes an array while a non-numeric one indexes an object. So `'.0.'` means
"first array element." That's powerful and it's why every asserter can target
nested data with a string, but it's a small grammar a reader has to discover
by reading the implementation (`audit.md` Lens 7 flags it). What breaks
without it: every asserter would need its own nested-access logic, and the
six checks would each re-implement object/array walking.

### Move 3 — the principle

**When validation logic becomes data, adding a check is editing a list, not
writing code — and the checks become portable across every consumer.** The
inverse design (a `validateDiagnosis()` with inline `if (!x.conclusion)
issues.push(...)`) ties each check to one capability and one call site. Pull
the check into a rule object and the same `{ type: 'required', path: ... }`
validates a diagnosis, a recommendation, or a replay artifact. This is the
exact move `audit.md` Lens 5 recommends for the pricing `if`-ladder: turn
control flow into a data table the engine reads.

---

## Primary diagram

```
  structural-diff — the full picture

  ┌─ caller (per capability) ──────────────────────────────────────┐
  │  rules: StructuralDiffRule[]   ← declarative correctness spec   │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ value + rules
  ┌─ evaluateStructuralDiff ──────▼─────────────────────────────────┐
  │  for rule of rules:                                              │
  │    switch(rule.type) → assertXRule(value, rule, issues)          │
  │      └─ each asserter: getPath(value, rule.path) → compare       │
  │  return { ok, issues }                                           │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ result
  ┌─ replay-runner / promote ─────▼─────────────────────────────────┐
  │  pass/fail feeds the correctness baseline (promoted fixtures)   │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** This engine backs replay-artifact assertions and the
detection-scorer — when a recorded agent run is replayed, its output is
checked against a rule list to decide pass/fail, and passing runs get promoted
to correctness-baseline fixtures. Because the rules are data, a capability's
correctness spec lives next to it without dragging validation code.

**The rule union — `packages/evals/src/structural-diff.ts:11-17`:**

```
  export type StructuralDiffRule =
    | { type: 'required';     path: string; message? }
    | { type: 'equals';       path: string; expected: unknown; message? }
    | { type: 'number';       path: string; expected: number; tolerance?; message? }
    | { type: 'arrayCount';   path: string; exact?; min?; max?; message? }
    | { type: 'containsText'; path: string; text: string; caseSensitive?; message? }
    | { type: 'arrayIncludes';path: string; value: unknown; itemPath?; message? };
        │
        └─ six variants, each with exactly the fields its check needs.
           the `type` discriminant is the contract between caller and engine.
```

**The engine — `structural-diff.ts:20-47`:**

```
  export function evaluateStructuralDiff(value, rules): StructuralDiffResult {
    const issues = [];
    for (const rule of rules) {
      switch (rule.type) {                 ← one dispatch point for all six strategies
        case 'required':   assertRequiredRule(value, rule, issues); break;
        case 'number':     assertNumberRule(value, rule, issues); break;
        case 'arrayCount': assertArrayCountRule(value, rule, issues); break;
        ... (equals, containsText, arrayIncludes)
      }
    }
    return { ok: issues.length === 0, issues };   ← aggregate, never throw (see audit Lens 6)
  }
```

Note it returns `{ ok, issues }` and never throws — same error-defined-out
discipline as `json-output` and `ndjson-stream`. A failed check is a value in
`issues[]`, not an exception.

**The shared traversal with its DSL — `structural-diff.ts:53-74`:**

```
  export function getPath(value, path): { exists, value } {
    const parts = path.split('.').filter(Boolean);
    let current = value;
    for (const part of parts) {
      if (Array.isArray(current)) {
        const index = Number(part);                    ← numeric segment = array index
        if (!Number.isInteger(index) || index < 0 || index >= current.length)
          return { exists: false, value: undefined };  ← out-of-range = "not found", not crash
        current = current[index];
        continue;
      }
      if (!current || typeof current !== 'object' || !(part in current))
        return { exists: false, value: undefined };    ← missing key = "not found"
      current = current[part];
    }
    return { exists: true, value: current };
  }
        │
        └─ the '.0.'-means-array-index grammar lives here and is undocumented;
           a one-line comment on the path format would remove the "huh?".
```

**One subtle asserter — `assertArrayIncludesRule` (`structural-diff.ts:162`):**
it checks whether *any* array item matches, optionally drilling into each item
via `itemPath`, and even handles the case where the item's field is itself an
array. That's real behaviour hidden behind one declarative rule
`{ type: 'arrayIncludes', path: 'recommendations', itemPath: 'feature',
value: 'voucher' }`.

---

## Elaborate

This is the **Interpreter** pattern (GoF) — rules are a tiny language,
`evaluateStructuralDiff` is its interpreter — fused with
**specification-as-data**. The same shape powers JSON Schema validators,
ESLint rule configs, and database query planners: separate the *declaration*
of what's wanted from the *mechanism* that checks it.

Why it's the right call here specifically: AptKit's eval backbone is
replay-centric — record a run, assert it, promote it to a fixture. If every
assertion were bespoke code, the correctness baseline would be code that
drifts with the agent. As rule data, the baseline is inspectable, diffable,
and can live alongside the fixture JSON. The tradeoff AptKit accepts: a rules
engine is more indirection than a one-off `if`, and a genuinely novel check
(something none of the six types express) requires extending the engine, not
just adding a rule. For the checks evals actually needs — presence, count,
equality, substring, membership — six types cover it, so the indirection pays
off. The `getPath` DSL's undocumented grammar is the one rough edge.

---

## Interview defense

**Q: "Why a rules engine instead of just writing validation functions?"**

Because the validation then becomes portable data instead of per-capability
code. Six rule types behind one `evaluate` walk means the recommendation
agent, the diagnostic agent, and the replay runner all reuse the same engine
with different rule lists — and the correctness baseline is inspectable JSON,
not code that drifts. The cost is one layer of indirection and the fact that a
truly novel check means extending the engine. For presence/count/equality/
substring/membership, that bar is rarely hit.

```
  bespoke (M call sites)        rules-as-data (1 engine)
  validateDiagnosis() {}        evaluate(value, diagnosisRules)
  validateRecs()      {}        evaluate(value, recRules)
  validateReplay()    {}        evaluate(value, replayRules)
   logic copied per type         logic shared; rules differ
```

**Anchor:** "Six rule types, one walk — adding a check is editing a list, not
writing a function."

**Q: "What's the hidden gotcha?"** The dot-path grammar: `'evidence.0.source'`
means "array index 0," and that's not documented anywhere — a reader infers it
from `getPath` numeric-segment handling. The fix is a one-line doc, not a
redesign.

---

## Validate

1. **Reconstruct:** write the `evaluateStructuralDiff` loop + switch from
   memory. Check against `structural-diff.ts:20`.
2. **Explain:** why does the engine return `{ ok, issues }` instead of
   throwing on the first failure? (Collects *all* issues; matches the
   error-defined-out discipline in Lens 6.)
3. **Apply:** write the rule list that asserts a diagnosis has a non-empty
   `conclusion`, at least one `evidence` item, and `confidence` equal to
   `'high'`. (Three rules: `required`, `arrayCount min:1`, `equals`.)
4. **Defend:** `audit.md` Lens 5 says the OpenAI pricing `if`-ladder
   (`usage-ledger.ts:71`) should become a data table. Argue why that's the
   *same move* as this file's pattern, and what the pricing "engine" would
   look like.

---

## See also

- `01-model-provider-deep-module.md` — another deep module; depth-by-hiding
  vs. this file's depth-by-breadth.
- `audit.md` Lens 5 (pricing should copy this), Lens 6 (error-defined-out),
  Lens 7 (the `getPath` DSL).
- `.aipe/study-ai-engineering/` — how structural-diff plugs into the replay/
  eval loop as an AI correctness gate.
