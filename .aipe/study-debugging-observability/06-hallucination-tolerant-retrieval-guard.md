# The hallucination-tolerant retrieval guard (the fix + the regression)

**Industry name(s):** defensive input validation / fail-open filter /
regression guard. **Type:** Industry standard.

## Zoom out, then zoom in

This is the back half of the war story (`04`). Once the trajectory pointed at a
hallucinated `{textContains}` filter as the cause, the fix had to make the
retrieval tool *robust to bad model inputs* — because you can't stop a weak model
from inventing arguments, you can only stop those arguments from silently zeroing
results. Then a regression test freezes that behavior so it never returns.

```
  Zoom out — where the guard lives

  ┌─ Runtime layer (agent loop) ────────────────────────────┐
  │  model decides args (may hallucinate {textContains:...}) │
  └──────────────────────────────┬───────────────────────────┘
                                 │ tool call with args
  ┌─ Retrieval layer ────────────▼───────────────────────────┐
  │  search_knowledge_base tool                              │
  │    ★ matchesFilter() — ignores unknown keys ★            │ ← we are here
  │    minTopK floor                                         │
  └──────────────────────────────┬───────────────────────────┘
                                 │ ranked hits (never zeroed by a phantom key)
  ┌─ Vector store ───────────────▼───────────────────────────┐
  │  InMemoryVectorStore (cosine scan)                       │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *how does a tool stay useful when the model feeds it
garbage arguments?* The answer is fail-open on unknown filter keys — an absent
key is ignored, not treated as "exclude everything." That one decision converts a
silent zero-result failure into a robust search.

## The structure pass

**Layers.** Runtime (the model picks args) and Retrieval (the tool applies them).
The trust boundary between them is the joint.

**Axis — trace it on `trust`: can the tool trust its own arguments?**

```
  "can search_knowledge_base trust the args the model gave it?"

  ┌─ Runtime: model ─────────────────────────────┐
  │ produces filter args  ── UNTRUSTED            │  → may hallucinate keys
  │ (Gemma emulates tool-calling; no real schema  │     (e.g. {textContains})
  │  enforcement on a weak local model)           │
  └─────────────────────────┬─────────────────────┘
                            │ trust flips here  ── the seam
  ┌─ Retrieval: tool ───────▼─────────────────────┐
  │ must DEFEND against bad args ── fail open on   │  → unknown key ignored,
  │ unknown keys, floor the top_k                  │     not "match nothing"
  └────────────────────────────────────────────────┘
```

**Seam.** The tool's argument boundary. Trust flips across it: above, the model's
args are untrusted (a weak model with emulated tool-calling can invent anything);
below, the tool must not let bad args cause silent failure. The fix lives exactly
on this seam — that's why it's a tool-side change, not a prompt change. You harden
the boundary, not the thing that crosses it.

## How it works

### Move 1 — the mental model

You've written a query builder that ignores `undefined` filter params instead of
generating `WHERE col = undefined` — an absent filter shouldn't match *nothing*,
it should match *everything*. Same instinct. A filter key the data doesn't have
should be a no-op, not a universal exclusion. The bug was the opposite default:
an unknown key excluded every row.

```
  The pattern — fail open on unknown filter keys

  filter = { textContains: "moon" }   ← key NO chunk carries

  WRONG (old):  every chunk lacks textContains
                → every chunk fails the match
                → results: []   ◄── silent zero

  RIGHT (fix):  key absent from chunk.meta → IGNORE it
                → filter is a no-op for this key
                → results: [ ...real hits ]  ◄── survives
```

### Move 2 — the step-by-step walkthrough

**The fix — `matchesFilter` ignores keys a chunk doesn't have.** The whole
correction is the predicate's logic: a filter key only excludes a hit that *has*
that key with a *different* value. A key absent from the chunk's meta is skipped.

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:101-106
function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  // A filter key only excludes hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
  // filter (e.g. {textContains: "x"}) can't silently wipe every result.
  return Object.entries(filter).every(
    ([key, value]) => !(key in hit.meta) || hit.meta[key] === value,
  );
}
```

Read the predicate: for every `[key, value]` in the filter, the hit passes if
**either** the key isn't in the hit's meta (`!(key in hit.meta)` — ignore it) OR
the values match (`hit.meta[key] === value`). A hallucinated `textContains` key
hits the first branch for every chunk, so it's a no-op — the search proceeds on
the real query. A *real* filter key (`docId`) still works exactly as before: a
chunk that has the key with a different value fails the match. The fix is
surgical — it changes only the absent-key case.

**The over-fetch that makes filtering honest.** Because a post-filter can drop
hits, the handler over-fetches before filtering so it can still return up to
`topK`:

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:88-90
const fetchK = filter ? topK * 4 : topK;            // over-fetch when filtering
let hits = await pipeline.query(query, fetchK);
if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
```

Without the `* 4`, a filter that legitimately drops some hits could leave you
short of `topK` even when more matches exist deeper in the ranking.

**The companion fix — `minTopK` floors a starved retrieval.** The same incident
exposed a sibling failure mode: a weak model passing `top_k: 1` starves its own
retrieval on a multi-part question. The floor lifts the requested `top_k` to a
configured minimum:

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:51, 80-81
const minTopK = Math.max(1, options.minTopK ?? 1);
// ...
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);       // model can't ask for fewer than the floor
```

Both fixes share a theme: defend the tool against a weak model's choices.

**The regression guard — the bug frozen as a test.** This is the prevention step
of the incident arc. The exact war-story scenario is now a test that fails if
the fix ever regresses:

```typescript
// packages/retrieval/test/search-knowledge-base-tool.test.ts:105-117
test('ignores filter keys absent from chunk metadata (a hallucinated filter does not wipe results)', async () => {
  const pipeline = await seededPipeline();
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
  const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });
  // A weak model invents a filter key no chunk carries. It must not zero out retrieval.
  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'how often does the moon orbit earth',
    filter: { textContains: 'moon' },                 // the exact hallucinated key from the incident
  });
  const payload = result as { results: unknown[] };
  assert.ok(payload.results.length > 0, 'hallucinated filter key should be ignored, not exclude everything');
});
```

The test name *is* documentation — it states the incident in one line. The
sibling floor has its own guard (`...test.ts:77-89`, "floors top_k to minTopK so
a weak model cannot starve retrieval"). These two tests are the repo's incident
runbook — there's no separate written playbook; the prevention lives next to the
code as executable specification.

### Move 2.5 — current state vs the unbuilt fix

The shipped fix makes the failure *not happen*. It does not make the failure
*visible* if a different version of it happens. That's the gap.

```
  Comparison — what shipped vs what's still missing

  shipped (the fix)                    unbuilt (the observability fix)
  ─────────────────────                ───────────────────────────────
  matchesFilter ignores absent keys    a zero-hit WARNING event
  minTopK floor                        emitted when results.length === 0
  regression tests                     → surfaces ANY future silent-empty
                                         retrieval at emit time, not after
  prevents THIS bug                       a user complaint
                                       → would have flagged the original
                                         incident at step 3 of the backward
                                         read (see 04), collapsing 4 reads to 1
```

The tool today returns `{ query, results: [] }` on zero hits
(`search-knowledge-base-tool.ts:92-95`) with no event — confirmed: there is no
`warning`/`error` emission anywhere in `packages/retrieval/src`. The one-line
addition would be a `trace.emit({ type: 'warning', ... })` (or a tool-result flag
the loop turns into one) when the result set is empty. It doesn't fix a bug — it
makes the *next* silent-empty failure announce itself. That's the highest-leverage
unbuilt observability improvement in the repo (audit lens 8, finding 1).

### Move 2 variant — the load-bearing skeleton

```
  Kernel of a fail-open input guard

  1. identify the untrusted input    ── model-supplied filter args
  2. choose the safe default         ── unknown key → ignore (no-op), not exclude
  3. preserve the legitimate case    ── real keys still filter correctly
  4. freeze it with a regression test ── the exact bad input must stay handled
```

- **Drop the fail-open default** and you're back to the bug: a phantom key zeroes
  every result.
- **Drop "preserve the legitimate case"** and you'd "fix" it by ignoring *all*
  filters — now `docId` filtering breaks. The fix must be surgical.
- **Drop the regression test** and the next refactor silently reintroduces the
  exact production incident.

**Skeleton vs hardening.** The fail-open predicate is the kernel. The
over-fetch (`* 4`), the `minTopK` floor, and the unbuilt zero-hit warning are
hardening — each closes a related hole, none is the core fix.

### Move 3 — the principle

You can't make a weak model send good arguments — so make the tool robust to bad
ones, and fail *open*, not *silent*. The deepest lesson of the whole war story is
about defaults: the original code's default for an unknown key was "exclude
everything," the worst possible default because it fails silently. Defensive code
at a trust boundary should degrade toward *doing the obvious thing* (ignore what
you don't understand) and, where it can't, toward *being loud* (the unbuilt
warning) — never toward quietly returning nothing.

## Primary diagram

```
  The retrieval guard — fix, floor, and the unbuilt warning

  ┌─ Runtime: model ──────────────────────────────────────────────┐
  │  picks args, may hallucinate {textContains:"x"} / pass top_k:1 │ UNTRUSTED
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ trust flips ── the tool must defend
  ┌─ Retrieval: search_knowledge_base ─▼──────────────────────────┐
  │  topK = max(requestedTopK, minTopK)        ◄── floor (line 81) │
  │  fetchK = filter ? topK*4 : topK           ◄── over-fetch (88) │
  │  hits.filter(matchesFilter)                                    │
  │    matchesFilter: absent key → IGNORE      ◄── the FIX (101-6) │
  │  results.length === 0 ? ──► [no event today]  ◄── UNBUILT:     │
  │                              should emit warning                │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ ranked hits (never zeroed by a phantom key)
  ┌─ Test layer (prevention) ────▼─────────────────────────────────┐
  │  test: hallucinated filter does NOT wipe results (105-117)     │
  │  test: minTopK floor (77-89)         ── the incident runbook    │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

Fail-open vs fail-closed is a classic reliability dial, and the right setting is
context-dependent: a *security* check fails closed (deny on doubt), a *retrieval
filter* fails open (return data on doubt) because a silent empty result is worse
than an over-broad one. The repo picked the right default for the domain. This
also sits on the LLM-security seam — `study-security` treats untrusted model
output as an input-validation boundary; here the same boundary is treated as a
*reliability* concern. Same seam, two lenses.

Read next: `04-reading-the-trajectory-backward.md` (the diagnosis that led here),
`05-deterministic-replay-reproduction.md` (how the regression test replays).

## Interview defense

**Q: A weak model passed a bad filter and zeroed all results. How do you fix it?**
You can't stop the model from inventing arguments, so you harden the tool: a
filter key the data doesn't carry is *ignored*, not treated as "exclude
everything." Real keys still filter. Then freeze the exact bad input as a
regression test. The fix lives at the trust boundary, not in the prompt.

```
  unknown key → no-op (fail open)   |   real key → still filters
```

**Q: What's the part people miss?**
The default direction of failure. The bug wasn't "filtering is wrong" — it was
that the *unknown-key default was exclude-everything*, which fails silently. Fail
open for retrieval; a silent empty result is the worst outcome.

**Q: Is the incident fully closed?**
The bug is fixed and guarded, but the *blind spot* isn't. Empty retrieval still
emits no event — a future silent-empty failure would again need a backward read
to find. The one-line close is a zero-hit `warning` event; it's the
highest-leverage unbuilt observability change in the repo.

## See also

- `04-reading-the-trajectory-backward.md` — the diagnosis that produced this fix.
- `05-deterministic-replay-reproduction.md` — how regression tests replay.
- `audit.md` lens 7 (incident arc), lens 8 (silent-empty blind spot).
- `study-testing` — the regression test as a correctness baseline.
- `study-security` — untrusted model output as an input-validation boundary.
- `study-ai-engineering` — the RAG retrieval pipeline this guards.
