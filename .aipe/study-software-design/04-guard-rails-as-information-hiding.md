# 04 — Guard Rails as Information Hiding

**Subtitle:** Defining errors out of existence · the tool absorbs model weakness
so callers never see it — *Project-specific* (the `search_knowledge_base` tool's
`minTopK` floor + hallucination-tolerant `matchesFilter`).

---

## Zoom out, then zoom in

When a weak local model drives retrieval, it does dumb things: it asks for
`top_k: 1` on a multi-part question and starves itself; it hallucinates a filter
key like `{textContains: "x"}` that, taken literally, would wipe every result.
The `search_knowledge_base` tool is where those failure modes go to die — it
encodes "the thing calling me may be a weak model" so the agent loop and the
pipeline never have to.

```
  Zoom out — the guard rails sit in the tool, between model and pipeline

  ┌─ Agent loop ─────────────────────────────────────────────────┐
  │  model decides to call search_knowledge_base(query, top_k, ?) │
  └────────────────────────────┬───────────────────────────────────┘
                               │ tool args (possibly dumb / hallucinated)
  ┌─ search_knowledge_base tool (★ here) ──▼────────────────────────┐
  │  minTopK floor   +   hallucination-tolerant matchesFilter        │
  │  (absorbs the model's weakness; never leaks it downward)         │
  └────────────────────────────┬───────────────────────────────────┘
                               │ pipeline.query(query, fetchK)
  ┌─ Retrieval pipeline ───────▼───────────────────────────────────┐
  │  embed → store.search → ranked hits (knows nothing of models)   │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is Ousterhout's favorite — **define errors out of
existence.** Instead of detecting "the model asked for too few results" or "the
filter matched nothing" and recovering, the tool *redefines the operation* so
those cases can't arise. The question it answers: how do you make retrieval
robust to a model that doesn't know how to use it, without scattering
model-defensiveness across the pipeline?

---

## Structure pass

- **Layers:** model (untrusted input) → the tool handler (guard rails) → the
  pipeline (trusts its input).
- **Axis — "who handles the model being weak?":** trace it.
  - model → is the source of the weakness.
  - tool handler → **the only place it's handled.** `minTopK` and `matchesFilter`
    live here (`search-knowledge-base-tool.ts:51, 101`).
  - pipeline → trusts its arguments completely. `queryKnowledgeBase` never sees a
    `top_k: 1` or a hallucinated filter — the tool already fixed both.
- **Seam:** the tool/pipeline boundary. Trust flips from "untrusted" above to
  "trusted" below. Classic validation seam — but built by *redefinition*, not
  rejection.

---

## How it works

### Move 1 — the mental model

You know how a well-designed form input *clamps* a number instead of erroring —
`Math.min(Math.max(value, 1), 100)` so there's no "invalid quantity" branch
anywhere downstream? The tool clamps the model's requests the same way. The whole
move is: don't validate-and-reject, *clamp-and-proceed* so the bad case stops
existing.

```
  Pattern — clamp the floor, ignore the noise (two guard rails)

  model asks ──► topK = max(requested, minTopK)        ← can't starve retrieval
                 fetchK = filter ? topK*4 : topK       ← over-fetch to survive filter
                 │
                 ▼
  hits ──► filter ? hits.filter(matchesFilter).slice(0, topK) : hits
                 │
                 └─ matchesFilter: a key absent from a chunk's meta is IGNORED
                    → a hallucinated filter key can't wipe every result
```

The strategy: **two redefinitions — a floor under `top_k` and a "missing key
means pass" filter — turn two whole classes of model error into non-events.**

### Move 2 — the step-by-step walkthrough

**Guard rail 1 — the `minTopK` floor.** A weak model asking `top_k: 1` was the
observed cause of multi-part-question misses. Rather than detect it, the tool
floors it:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:50-51, 79-81
const minTopK = Math.max(1, options.minTopK ?? 1);
// ...
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);   // ← the floor: model can't go below it
```

The model *cannot* starve its own retrieval when `minTopK > 1`. There's no error
path because the bad value is impossible after this line. (The honest caveat,
flagged in `audit.md` lens 5: `minTopK` defaults to 1, so the guard is *off* out
of the box — a knob that should default to the safe value. The mechanism is
right; the default is the finding.)

**Guard rail 2 — the hallucination-tolerant filter.** This is the
define-out-of-existence move in its purest form. A naive filter says "exclude any
hit that doesn't match" — so a hallucinated key like `{textContains: "x"}`
(which no chunk has) excludes *everything*. The tool inverts the rule:

```ts
// search-knowledge-base-tool.ts:101-106
function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  // A filter key only excludes hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
  // filter (e.g. {textContains: "x"}) can't silently wipe every result.
  return Object.entries(filter).every(([key, value]) =>
    !(key in hit.meta) || hit.meta[key] === value);
}
```

`!(key in hit.meta) || hit.meta[key] === value` — a key the chunk doesn't have
passes automatically. Real filter keys (`docId`, `kind`) still work; hallucinated
ones become no-ops. The class of error "model invented a filter and got zero
results" no longer exists.

**The supporting move — over-fetch so the filter has room.** Filtering reduces
the result set, so the tool fetches *more* than `topK` when a filter is present,
then trims after:

```ts
// search-knowledge-base-tool.ts:88-90
const fetchK = filter ? topK * 4 : topK;          // over-fetch under a filter
let hits = await pipeline.query(query, fetchK);
if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
```

This is exactly the same workaround `@aptkit/memory` does
(`conversation-memory.ts:94`, `max(k*4, 20)`) — and *that duplication is the leak*
called out in `audit.md` lens 3. The right home for filtering is the
`VectorStore` contract; until it grows a `filter?`, both consumers carry this
over-fetch. The guard rail is good design; the place it lives is the design debt.

```
  Layers-and-hops — guard rails between an untrusted model and a trusting pipeline

  ┌─ model (untrusted) ─┐  {query, top_k:1, filter:{bogus}}  ┌─ tool handler ──┐
  │  agentic decision   │ ─────────────────────────────────►│ floor top_k      │
  │                     │                                    │ over-fetch *4    │
  └─────────────────────┘                                    │ ignore bogus key │
                                                             └────────┬─────────┘
                                       pipeline.query(query, fetchK)   │ (clean args)
                                              ┌─ pipeline (trusts) ─────▼─────────┐
                                              │ embed → store.search → ranked hits │
                                              └─────────────────────────────────────┘
```

### Move 3 — the principle

The best error handling is the error you arranged not to have. Detecting and
recovering from "model asked for too little" or "model invented a filter" would
mean branches, logging, and retry logic spread across the pipeline. Redefining
the operation — floor the count, treat missing filter keys as a pass — deletes
both branches. The complexity didn't move; it *vanished*, and the model's
weakness stayed hidden inside the one module built to expect it.

---

## Primary diagram

```
  Guard rails as information hiding — full picture

  model emits tool args: { query, top_k? (maybe 1), filter? (maybe hallucinated) }
        │
  ══════▼══════ search_knowledge_base handler (search-knowledge-base-tool.ts) ═══
   topK   = max(requested ?? default, minTopK)          ← floor: no starvation
   fetchK = filter ? topK*4 : topK                      ← room to survive filter
   hits   = pipeline.query(query, fetchK)
   hits   = filter ? hits.filter(matchesFilter).slice(0,topK) : hits
            matchesFilter: !(key in meta) || meta[key]===value   ← bogus key = no-op
  ═══════════════════════════════════════════════════════════════════════════════
        │
   results: ranked chunks + citations — the model's weakness never reached here
        │   (NOTE: the over-fetch+filter is duplicated in @aptkit/memory — see audit lens 3)
```

---

## Elaborate

"Define errors out of existence" is the single highest-leverage idea in the book
for AI code specifically, because LLM inputs are *adversarially* sloppy in ways
ordinary function arguments aren't — the model will confidently pass nonsense.
You can meet that with validation-and-rejection (a branch per failure mode) or
with redefinition (no branch). aptkit chose redefinition in the two places it
counts, and the comments at the redefinition sites are load-bearing: delete the
`matchesFilter` comment in a future refactor and the `!(key in hit.meta)` reads
like a bug, someone "fixes" it to a strict match, and a hallucinated filter once
again wipes every result (`audit.md` lens 7, obviousness).

The companion idea on the *provider* side is `02-emulation-hidden-behind-complete
.md` — there the model weakness is "can't do tools," hidden in the provider; here
it's "uses the tool badly," hidden in the tool. Same philosophy, two layers.

---

## Interview defense

**Q: A weak model passes `top_k: 1` and hallucinates a filter key. What happens?**

Nothing bad, by design. `top_k` is floored to `minTopK`, so it can't starve
retrieval. The hallucinated filter key is one the chunks don't have, and
`matchesFilter` ignores keys absent from a chunk's meta — so it's a no-op instead
of excluding everything. Both failure modes are defined out of existence rather
than detected and recovered.

```
  top_k:1   ──► max(1, minTopK)        → floored, no starvation
  {bogus:x} ──► !(bogus in meta) → true → ignored, no wipeout
```

**Q: Where's the design debt in this otherwise-clean guard?**

The over-fetch-then-filter (`topK*4`) is duplicated in conversation memory
because the `VectorStore` contract has no metadata filter. Same workaround, two
files. The fix is to push filtering down into the contract — pgvector does it in
SQL for free — which also kills the magic-number drift (`topK*4` here vs
`max(k*4, 20)` in memory). And `minTopK` defaults to off; it should default to a
safe floor with opt-out.

*Anchor:* "Don't validate-and-reject a weak model — clamp-and-proceed. Floor the
`top_k`, treat a missing filter key as a pass, and the two worst LLM-retrieval
failure modes simply can't occur."

---

## See also

- `02-emulation-hidden-behind-complete.md` — the provider-side twin (hides "can't
  do tools"; this hides "uses the tool badly").
- `03-contract-as-the-product.md` — the missing `VectorStore.filter?` that forces
  the duplicated over-fetch.
- `audit.md` — lens 5 (`minTopK` knob), lens 6 (errors defined out), lens 7
  (the load-bearing comment).
- `../study-agent-architecture/` — retrieval as an agent tool; `../study-testing/`
  — testing the guard rails deterministically.
