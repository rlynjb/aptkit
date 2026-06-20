# structural-diff integrity

**Industry name(s):** schema validation / runtime shape assertion; the relational cousins are `NOT NULL`, type, and `CHECK` constraints. **Type label:** Industry standard (constraint enforcement), implemented here as a hand-rolled rule engine.

## Zoom out, then zoom in

A database enforces constraints for you: declare a column `NOT NULL` and no row without it can ever be written. AptKit has no database, so JSON on disk accepts literally any shape. The constraint layer that a DB would give for free is hand-written in `packages/evals` — and it's the only thing standing between a malformed artifact and the test suite trusting it.

```
  Zoom out — where the integrity layer sits

  ┌─ WRITE side ────────────────────────────────────────┐
  │  JSON.stringify(artifact) → file   (NO enforcement)  │
  └───────────────────────────┬─────────────────────────┘
                              │  *.json (any shape accepted)
  ┌─ STORED ───────────────────────────────────────────▼┐
  │  artifacts/replays/*.json,  fixtures/*.json          │
  └───────────────────────────┬─────────────────────────┘
                              │  read back → validate
  ┌─ INTEGRITY layer (packages/evals) ─────────────────▼┐
  │  ★ assertions.ts + structural-diff.ts ★              │ ← we are here
  │   = NOT NULL + type + CHECK, enforced at read time   │
  └───────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **runtime shape assertion over JSON-shaped data** — a small rule engine that walks a path into an `unknown` value and reports every constraint it violates. The question it answers: with no database to enforce constraints at write time, how do you guarantee a persisted value has the shape your code depends on before you trust it?

## Structure pass

**Layers.** Two: the *generic rule engine* (`structural-diff.ts` — path resolution + rule types, domain-agnostic) and the *domain assertions* (`assertions.ts` — the specific shapes AptKit's artifacts must have, built on the engine). This split is the whole design: a reusable constraint primitive, then the actual constraints declared on top.

**Axis — trace "is this value trusted to have its shape?":**

```
  axis: "do we trust this value's shape?"

  ┌─ raw JSON (unknown) ─┐  seam: validation  ┌─ validated ─┐
  │  could be anything   │ ══════╪══════════► │  shape       │
  │  TS type is `unknown`│  (trust flips on    │  guaranteed  │
  │                      │   ok === true)      │  by the rules│
  └──────────────────────┘                     └─────────────┘
```

**Seam.** The validation call is the joint where `unknown` becomes trusted. Before it, the data is typed `unknown` (the honest type for parsed JSON); after a passing assertion, the code proceeds as if the shape holds. That boundary is exactly where a database would sit — and AptKit puts a function there instead.

## How it works

### Move 1 — the mental model

The engine is a list of declarative rules evaluated against a value, each rule navigating a dotted path and pushing an issue if it's violated. It's the shape of a validation library (Zod, Joi) reduced to its essence: path + predicate + message.

```
  The pattern — rules over a value, collect every violation

  rules = [ {required, 'eval.ok'}, {equals, 'schemaVersion', 1}, ... ]

  for each rule:
    found = getPath(value, rule.path)   ← navigate dotted path
    if rule violated → issues.push({ path, message })

  result = { ok: issues.length === 0, issues }
              └─ collects ALL issues, doesn't stop at the first
```

The kernel: a path resolver (`getPath`) + a rule loop that accumulates issues. Strip `getPath` and rules can't address nested fields; strip the accumulation (fail-fast instead) and you'd only ever see one error at a time, making a malformed file painful to fix.

### Move 2 — the walkthrough

**The path resolver — addressing into `unknown`.** `getPath(value, 'provider.id')` splits on `.` and walks the object, returning `{ exists, value }`. Crucially, it handles array indices too: `'0.title'` navigates into `array[0].title`. Bridge: it's `lodash.get` for an `unknown` — the thing that lets a flat rule list reach a deeply nested constraint.

```
  getPath('recommendations.0.title') (execution trace)

  parts = ['recommendations', '0', 'title']
    current = artifact
    'recommendations' → current = artifact.recommendations (array)
    '0'               → index 0 → current = recommendations[0]
    'title'           → current = recommendations[0].title
  → { exists: true, value: 'Re-engagement campaign...' }

  if any step misses → { exists: false } → a "required path missing" issue
```

**The required rule — the `NOT NULL` analog.** `assertRequiredPaths(value, ['schemaVersion', 'eval.ok', ...])` checks each path exists. This is the most-used rule and the direct equivalent of declaring columns `NOT NULL`: the field must be present or the value is rejected.

**The typed `CHECK` rules.** Beyond presence, `assertReplayArtifactShape` adds value constraints by hand: `schemaVersion !== 1` (an `equals` check), `createdAt` must `Date.parse` to a valid date, `durationMs >= 0`, `modelTurns >= 0`. Bridge: these are `CHECK (duration_ms >= 0)` constraints, written as `if` statements because there's no DDL to declare them in.

```
  the CHECK constraints (assertions.ts:83-97)

  schemaVersion !== 1          → issue  (CHECK schemaVersion = 1)
  !Date.parse(createdAt)       → issue  (CHECK createdAt IS valid timestamp)
  durationMs < 0               → issue  (CHECK durationMs >= 0)
  modelTurns < 0               → issue  (CHECK modelTurns >= 0)
  trace not an array           → issue  (CHECK trace IS array)
```

**The nested composition — constraints that delegate.** `assertReplayArtifactShape` validates the top level, then calls `assertRecommendationShape` on the `recommendations` array and re-prefixes the child issues (`recommendations.${issue.path}`). Bridge: it's a foreign-key-style cascade — validate the parent, then validate each child against its own shape, with the path prefix telling you exactly where the violation is. This is how a flat rule engine validates a tree.

**The dispatch by discriminant.** `assertCapabilityReplayArtifactShape` sniffs the artifact (`capabilityId === 'query-agent'`, or `Array.isArray(output.anomalies)`, etc.) and routes to the right per-capability validator. This is the integrity layer reading the same discriminant the tagged union uses (`02-tagged-union-event-log.md`) — the shape check is polymorphic over capability.

**The constraint with no SQL analog — secret scanning.** `findSecretLikeString` recursively walks the *entire* value looking for `sk-...` patterns or `OPENAI_API_KEY=`, and fails the assertion if found. Bridge: there's no `CHECK` for "no field anywhere may contain a secret" — this is a data-exposure invariant that only an app-level walker can express. It's the most AptKit-specific constraint: artifacts and fixtures are committed to git and inlined into the published npm bundle, so a leaked key in one would ship publicly.

### Move 3 — the principle

When you have no database, every invariant you don't enforce in code is an invariant that isn't enforced. The structural-diff engine is the disciplined version of "validate at the boundary": a reusable rule primitive, domain constraints declared on top, every violation collected with a precise path. **The catch is the one the audit hammers: these constraints fire only when you run them. A database enforces on every write, synchronously; this fires at read time, on demand. A fixture nobody re-validates can violate every rule silently.** That gap is the price of having no DB — and the reason these functions are run in CI, not just locally.

## Primary diagram

The full integrity layer: generic engine, domain assertions, and the constraint types mapped to their relational analogs.

```
  Integrity layer — engine + domain rules + relational analogs

  GENERIC ENGINE (structural-diff.ts)        DOMAIN RULES (assertions.ts)
  ──────────────────────────────────         ────────────────────────────
  getPath(value, 'a.b.0.c')  ← addresses     assertReplayArtifactShape
  evaluateStructuralDiff(value, rules)          ├ assertRequiredPaths  → NOT NULL
    ├ required    → NOT NULL                     ├ schemaVersion === 1 → CHECK
    ├ equals      → CHECK col = X                ├ durationMs >= 0     → CHECK
    ├ number      → CHECK col ≈ X                ├ trace is array      → CHECK
    ├ arrayCount  → CHECK cardinality            ├ assertRecommendationShape
    ├ containsText                               │    (nested, FK-cascade-style)
    └ arrayIncludes                              └ findSecretLikeString → (no SQL
                                                      analog — data-exposure guard)
  result = { ok, issues:[{path,message}] }    dispatch by capabilityId (discriminant)
```

## Implementation in codebase

**Use cases in AptKit.** The integrity layer runs in three places: the CLI eval (`eval-replay-artifacts` over `artifacts/replays/`), the promotion gate (`promote-replay-to-fixture.mjs` refuses to promote an invalid artifact), and the Studio loader. Every time an artifact is read back to be trusted — for promotion, for eval reporting — it passes through these assertions first. It's the read-time constraint enforcement for a repo with no write-time constraints.

**The generic engine** — `packages/evals/src/structural-diff.ts`:

```
  getPath (lines 53-74) — the path resolver
    const parts = path.split('.').filter(Boolean);
    for (const part of parts) {
      if (Array.isArray(current)) { ... index navigation ... }   ← lines 58-65
      if (!(part in current)) return { exists:false };           ← line 67
    }
         │
         └─ array-index handling (line 58) is what lets '0.title' address
            into an array — without it, rules couldn't reach array elements

  evaluateStructuralDiff (lines 20-47) — the rule loop
    for (const rule of rules) switch (rule.type) { ... }
    return { ok: issues.length === 0, issues };                  ← line 46
         │
         └─ accumulates ALL issues across all rules — a malformed artifact
            reports every problem at once, not just the first
```

**The domain constraints** — `packages/evals/src/assertions.ts`:

```
  assertReplayArtifactShape (lines 58-126)
    assertRequiredPaths(output, ['schemaVersion','eval.ok',...])  ← NOT NULL  (:59-72)
    if (output.schemaVersion !== 1) issues.push(...)              ← CHECK     (:83-85)
    if (!Date.parse(output.createdAt)) issues.push(...)           ← CHECK     (:87-89)
    if (output.durationMs < 0) issues.push(...)                   ← CHECK     (:91-93)
    assertRecommendationShape(recommendations)  → re-prefix child ← FK cascade (:103-111)
    findSecretLikeString(output)                 → data-exposure  ← no SQL    (:120-123)

  findSecretLikeString (lines 397-421) — the secret guard
    if (/sk-[A-Za-z0-9_-]{10,}/.test(value)) return issue;        ← line 399
         │
         └─ recurses every string in the object tree; this is why a leaked
            key in an artifact fails validation before it can be committed
            or published in the bundle
```

**The dispatch** — `assertions.ts:35-46`. `assertCapabilityReplayArtifactShape` branches on `capabilityId` / shape (`output.answer`, `output.diagnosis`, `output.anomalies`) to pick the right per-capability validator — reading the discriminant from `02-tagged-union-event-log.md`'s union and the artifact's own capability tag.

**The gate in action** — `scripts/promote-replay-to-fixture.mjs:34-37` calls `assertReplayArtifactShape` and throws if `!ok`. The integrity layer is what makes promotion (`04-fixture-promotion-lifecycle.md`) safe.

## Elaborate

This is schema-validation-at-the-boundary, the same idea behind Zod, io-ts, Joi, and JSON Schema validators. The reason AptKit hand-rolls it rather than pulling Zod: the rule engine is tiny (one file, six rule types), it produces path-precise issues that double as eval output, and the published bundle stays dependency-light. The constraint-as-data design (`StructuralDiffRule[]`) is itself a small data model — rules are values, so they can be composed and reused (the `evaluateStructuralDiff` engine is exported for any caller, not just artifacts).

Where it connects: this layer re-establishes at read time the guarantee the compiler gave at write time and lost at serialization (`01-type-as-schema.md`). It's the gate that protects promotion (`04`). The `schemaVersion === 1` rule is the read-side of the version story (`03`). And it dispatches on the same discriminant the event union uses (`02`). It is, in short, the keystone — everything else in the data model leans on it for correctness.

## Interview defense

**Q: With no database, how does AptKit guarantee a persisted value has the right shape?**
"A hand-rolled integrity layer in `packages/evals`. `structural-diff.ts` is a generic rule engine — `getPath` addresses dotted paths including array indices, `evaluateStructuralDiff` runs rules and collects every violation. `assertions.ts` declares the domain constraints on top: required paths are `NOT NULL`, `schemaVersion === 1` and `durationMs >= 0` are `CHECK` constraints, nested shapes cascade like foreign-key validation. It runs at read time, before any code trusts the value."

```
  raw JSON (unknown) ─validate─► trusted shape
  required → NOT NULL · equals/number → CHECK · nested → FK cascade
```

Anchor: *the evals layer is AptKit's constraint engine — `NOT NULL` and `CHECK`, enforced at read time.*

**Q: What's the constraint with no relational equivalent?**
"`findSecretLikeString` — it recursively walks every string in the artifact looking for `sk-...` or `OPENAI_API_KEY=` and fails validation if found. There's no SQL `CHECK` for 'no field anywhere may contain a secret.' It matters because artifacts and fixtures are committed to git and inlined into the published npm bundle, so a leaked key would ship publicly. It's a data-exposure invariant only an app-level walker can express."

Anchor: *the secret scan is the data-exposure constraint a database can't give you.*

**Q: The honest weakness — and the part people forget?**
"These constraints fire only when you run them. A database enforces on every write, synchronously, no opt-out. This fires at read time, on demand — so a hand-edited fixture that's never re-evaluated can violate every rule silently. That's the price of having no DB, and the mitigation is running the evals in CI, not just locally. The part people forget is that the engine *accumulates* all issues rather than failing fast — that's deliberate, so a malformed artifact tells you everything wrong at once, not one error per run."

## Validate

1. **Reconstruct.** Name the six rule types in `structural-diff.ts` and which maps to `NOT NULL`. (`required` → `NOT NULL`; plus `equals`, `number`, `arrayCount`, `containsText`, `arrayIncludes` — `structural-diff.ts:11-17`.)
2. **Explain.** Why does `getPath` need special handling for array indices (`structural-diff.ts:58-65`)? (So a rule path like `'recommendations.0.title'` can address into an array element, not just object keys.)
3. **Apply.** You add a required `costEstimate.totalUsd` field that must be `>= 0`. Write the two rules. (`{type:'required', path:'costEstimate.totalUsd'}` and a `number`/`CHECK` for `>= 0`, or an inline `if` in the domain assertion.)
4. **Defend.** Argue why AptKit re-validates shape at read time even though TypeScript types already describe it. (The compiler's guarantee dies at `JSON.parse` — `01-type-as-schema.md`'s seam — so the only enforcement on JSON-from-disk is this layer.) Then name the gap: it fires only when run.

## See also

- `01-type-as-schema.md` — the write-time guarantee this layer re-establishes at read time (the serialization seam).
- `03-versioned-artifact-schema.md` — the `schemaVersion === 1` rule lives in this layer.
- `04-fixture-promotion-lifecycle.md` — promotion is gated by `assertReplayArtifactShape`.
- `02-tagged-union-event-log.md` — the discriminant this layer dispatches on.
- `06-vector-store-row-model.md` — the contrast partner: this layer enforces invariants asynchronously when run; the corpus dimension check enforces its one invariant synchronously at write time, with a throw.
- `audit.md` — Lens 4 (transactions and integrity) — the load-bearing finding.
- `study-software-design` → information-hiding; `study-testing` — the eval semantics; `study-security` → secret handling (the `findSecretLikeString` guard).
