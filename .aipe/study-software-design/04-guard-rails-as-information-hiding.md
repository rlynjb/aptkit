# Guard-Rails as Information Hiding

**Industry name(s):** defensive defaults / define-errors-out / pull-
complexity-down · **type:** Industry standard (the principle) +
project-specific (the AI-model-weakness it hides)

A recurring move: the module owns a fact about how a weak local model
*fails*, and bakes the defense into a default or an error definition so
no caller has to know about the weakness. `minTopK`, the hallucination-
tolerant `matchesFilter`, and the loud dimension checks are three faces
of it — information hiding aimed specifically at model weakness. This
file also names the move's cost: one of those guards leaked into three
files.

---

## Zoom out, then zoom in

Here's where the guard-rails sit. They're not a layer — they're small
decisions scattered at the retrieval seam, each absorbing one way a weak
model or a misconfigured wiring would otherwise produce a silent bad
result.

```
  Zoom out — guard-rails at the retrieval seam

  ┌─ Client layer ───────────────────────────────────────────────┐
  │ RagQueryAgent / weak local model (Gemma) — may pass top_k:1,  │
  │ may hallucinate a filter key, may be wired to a wrong store    │
  └────────────────────────────┬──────────────────────────────────┘
                               │
  ┌─ Guard-rail seam ★ ────────▼──────────────────────────────────┐
  │ minTopK floor (tool:51) · matchesFilter tolerant (tool:101)   │  ← we are here
  │ assertWiring (pipeline:23) · assertDimension (store:37)        │
  └────────────────────────────┬──────────────────────────────────┘
                               │
  ┌─ Mechanism layer ──────────▼──────────────────────────────────┐
  │ cosine search / upsert — assumes inputs already validated      │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **information hiding applied to failure modes** —
the module knows how things go wrong and hides the defense, so the caller
gets a good result without understanding the trap. The question: *how do
you stop a weak model from sabotaging its own retrieval, without exposing
the weakness as a knob every caller must set?*

---

## The structure pass

**Layers.** Client (model/agent) → guard-rail seam → mechanism.

**Axis — trace `failure` (where does a bad input get contained?).**

```
  One axis: "where is a bad retrieval input contained?"

  ┌─ caller passes top_k:1 / a junk filter / a 512-dim vector ─┐
  │                                                            │
  │   ════════════════════════ guard-rail seam ═══════════════╪══►
  │                                                       (contained here)
  │   minTopK lifts it to a floor · matchesFilter ignores junk │
  │   keys · assertDimension throws before the corrupt search  │
  └────────────────────────────────────────────────────────────┘
       failure is contained AT the seam, never reaches the scan
```

**Seam.** The guard-rail boundary is load-bearing because the `failure`
axis-answer flips: above it the input may be bad; below it the mechanism
assumes it's clean. Every guard either *corrects* the input (minTopK),
*tolerates* it (matchesFilter), or *rejects* it loudly (assertDimension).

---

## How it works

### Move 1 — the mental model

You've defaulted a function argument so callers don't have to think about
it — `function paginate(items, pageSize = 20)`. The caller can override,
but the sensible behavior is built in. Guard-rails are that, with one
twist: the default isn't just convenient, it *defends against a known
failure mode*. The module knows the weak model passes `top_k: 1` and
starves itself, so the default floor quietly fixes it.

```
  Pattern — three shapes of guard, by how they handle bad input

   bad input ──► ┌─ CORRECT  ─┐ minTopK: lift to a floor, proceed
                 ├─ TOLERATE ─┤ matchesFilter: ignore unknown keys
                 └─ REJECT   ─┘ assertDimension: throw loud, stop
```

### Move 2 — the step-by-step walkthrough

**Guard 1 — `minTopK` corrects a self-starving model.** A weak local
model, asked a multi-part question, sometimes passes `top_k: 1` and
retrieves a single chunk — then can't answer the other parts. The tool
owns this knowledge (`search-knowledge-base-tool.ts:36–41`, :51):

```ts
const topK = Math.max(requestedTopK, minTopK);   // floor the request
```

The default `minTopK` is 1 (off), but a caller wiring a weak model sets
it to, say, 3, and the model *can't* starve its own retrieval anymore.
The caller doesn't have to understand *why* — the module knows the trap
and the floor hides it. This is complexity pulled down: the module owns
the decision and exposes an opt-in escape hatch, not a mandatory knob.

**Guard 2 — `matchesFilter` tolerates a hallucinated filter.** A weak
model sometimes invents a filter key that doesn't exist on any chunk
(`{textContains: "x"}`). A naive exact-match filter would then match
*nothing* and silently wipe every result. The tool defines that failure
out (`search-knowledge-base-tool.ts:101–106`):

```ts
function matchesFilter(hit, filter) {
  // A key only EXCLUDES hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored — a hallucinated key
  // can't wipe every result.
  return Object.entries(filter).every(
    ([key, value]) => !(key in hit.meta) || hit.meta[key] === value,
  );
}
```

The special case "model hallucinated a filter key" is erased by the
definition: an unknown key is simply ignored. No caller branches on
"did the model hallucinate?" — the function's shape makes the question
disappear.

**Guard 3 — the dimension checks reject loudly.** A corpus embedded at
768 dims can't be searched by a 512-dim query — the cosine math runs but
the ranking is garbage. This is a one-way door, so it's rejected at
wiring time, loud (`pipeline.ts:22`):

```ts
function assertWiring(wiring) {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(`dimension mismatch: embedder "${...}" is ${...}-dim but store is ${...}-dim ...`);
  }
}
```

And again per-vector inside the store (`in-memory-vector-store.ts:37`),
because a single bad vector slipping into `upsert` corrupts ranking
silently. Failing loud here is correct — a mismatch is a *wiring bug*,
not a runtime input, and a silent bad result is far worse than a crash.

```
  Layers-and-hops — each guard contains a different failure

  ┌─ Client (weak model) ──┐
  │  top_k:1   junk filter  512-dim vector
  └────┬─────────┬──────────────┬───────────┘
       │ hop A   │ hop B         │ hop C
       ▼         ▼               ▼
  ┌─ Guard seam ─────────────────────────────────────┐
  │ minTopK:    Math.max → floor (CORRECT, proceed)   │
  │ matchesFltr: unknown key ignored (TOLERATE)       │
  │ assertDim:  throw before the scan (REJECT, stop)  │
  └──────────────────────┬────────────────────────────┘
                         ▼
            cosine search — receives only clean inputs
```

### Move 2 variant — the load-bearing skeleton, and its leak

1. **Kernel:** the module owns a known failure mode + a default/definition
   that neutralizes it + an opt-in override where the caller legitimately
   needs control.

2. **What breaks if removed:**
   - Drop `minTopK` → weak models starve their own multi-part retrieval;
     the failure shows up as wrong *answers*, not errors — the hardest
     kind to debug.
   - Drop `matchesFilter`'s tolerance (use exact match) → one hallucinated
     key returns zero results; the agent says "I found nothing" when the
     answer was right there.
   - Drop the dimension checks → silent ranking corruption; the worst
     outcome, because nothing throws and the results just quietly get
     worse.

3. **The leak (the cost of this move, named bluntly).** The dimension
   guard is the *same decision* written in three files with three error
   strings: `pipeline.ts:23`, `in-memory-vector-store.ts:37`,
   `conversation-memory.ts:62`. `@aptkit/memory` even re-implements the
   pipeline's wiring check rather than calling `assertWiring`. The
   knowledge "embedder dim must equal store dim" crosses three modules —
   change the rule and you edit three places. **Fix:** export one
   `assertWiring(embedder, store)` from `@aptkit/retrieval` and call it
   from all three wiring-time sites. (The per-vector check inside the
   store is legitimately separate — that's runtime input validation, a
   different concern.)

### Move 3 — the principle

The best place to handle a failure is where you have the most information
about it, defined so the caller never has to know it exists. A weak
model's habits are knowledge the *retrieval module* holds best — so the
defense belongs there, baked into a default or an error definition, not
exposed as a knob. But the same discipline demands the defense live in
*one* place: a guard duplicated across three files is the principle
applied right and then leaked.

---

## Primary diagram

```
  Guard-rails as information hiding — full recap

  ┌─ Client: weak local model / agent / misconfigured wiring ───────┐
  │  doesn't know the traps — just calls search / index             │
  └────────────────────────────┬───────────────────────────────────┘
                               │
  ┌─ Guard-rail seam ★ ────────▼───────────────────────────────────┐
  │ CORRECT   minTopK (tool:51)          Math.max(requested, floor) │
  │ TOLERATE  matchesFilter (tool:101)   unknown key ⇒ ignored      │
  │ REJECT    assertWiring (pipeline:23) dim mismatch ⇒ throw loud   │
  │           assertDimension (store:37) bad vector ⇒ throw loud     │
  │           ⚠ LEAK: dim rule ALSO in memory:62 — 3 homes, 1 fact   │
  └────────────────────────────┬───────────────────────────────────┘
                               ▼
  ┌─ Mechanism: cosine search — assumes inputs are clean ───────────┐
  └───────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Two Ousterhout primitives meet here. *Pull complexity downward*: the
module owns the decision (the floor, the tolerance) rather than dumping a
knob on the caller. *Define errors out of existence*: `matchesFilter`'s
shape erases the "hallucinated key" special case, and the zero-vector
guard in cosine (`in-memory-vector-store.ts:56`, returns 0 not NaN) does
the same for empty vectors. Both reduce the number of cases a caller has
to reason about.

The AI-specific twist is what makes this worth a file: the failure modes
being hidden are *model weaknesses*, not classic input bugs. A weak local
model is an unreliable component, and the guard-rails are an
anti-fragility layer aimed at it. That's a pattern you'll reuse anywhere
you put a small open model in a pipeline — anchor it here.

Read next: `03-contract-as-the-product.md` (where the dimension field on
the contract comes from), `02-emulation-hidden-behind-the-port.md` (the
retry guard, the same instinct on the model side).

---

## Interview defense

**Q: Why floor `top_k` in the module instead of just telling callers to
pass a good value?** Because the caller doesn't have the knowledge —
the *module* knows weak local models pass `top_k: 1` and starve
multi-part retrieval. Pushing that as a required knob means every caller
re-learns the trap; baking it as a default (with an opt-in override)
means the trap is handled once, where the knowledge lives. That's pulling
complexity downward.

```
  knob pushed UP (bad)            default owned DOWN (good)
  ┌────────┐ "set top_k≥3 or     ┌────────┐ minTopK floor;
  │ caller │  retrieval breaks"  │ module │ caller need not know
  └────────┘ (every caller       └────────┘ (handled once)
             re-learns the trap)
```

Anchor: "handle the failure where the knowledge lives."

**Q: You have a dimension check in three files — defend or fix it?** Fix
it. It's the same invariant ("embedder dim == store dim") with three
error strings; `@aptkit/memory` even copies the pipeline's logic instead
of calling `assertWiring`. Change the rule and you edit three places —
classic information leakage. The fix is one exported `assertWiring`
called from all three wiring-time sites. The per-vector check inside the
store stays separate, because that's runtime input validation, a
genuinely different concern from wiring-time reconciliation.

Anchor: "one invariant, one home — the per-vector check is a different job."

---

## See also

- `03-contract-as-the-product.md` — the dimension field lives on the contract
- `02-emulation-hidden-behind-the-port.md` — the model-side retry guard
- `00-overview.md` — pull-complexity-down in context
- `audit.md` — lens 1 (the dimension leak), lens 5 (minTopK), lens 6 (define-out)
- `../study-testing/` — how the guards are exercised deterministically
- `../study-prompt-engineering/` — the model weaknesses these guards target
