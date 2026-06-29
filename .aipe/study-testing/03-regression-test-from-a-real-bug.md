# Regression test from a real bug

**Subtitle:** Regression test / bug-driven test / defect-localizing test —
*Industry-standard* practice, shown on a real aptkit defect.

## Zoom out, then zoom in

The fixture replay (`02`) guards against trajectory *drift*. This is the other
half of regression testing: when a specific bug is found and fixed, a named
test is written that fails on the old behavior and passes on the new — so the
bug can never silently come back. aptkit has a clean worked example, and it
lives at exactly the spot where a weak local model is most likely to misbehave.

```
  Zoom out — where this regression test sits

  ┌─ Agent layer ────────────────────────────────────────────────┐
  │  Gemma decides to search, INVENTS a filter key it never saw   │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  filter: { textContains: 'moon' }
  ┌─ Retrieval tool layer ────────▼───────────────────────────────┐
  │  search_knowledge_base   ★ THE BUG LIVED HERE ★               │ ← here
  │  old: unknown filter key → zero results (retrieval wiped)     │
  │  new: unknown filter key → ignored → results survive          │
  └───────────────────────────────┬───────────────────────────────┘
  ┌─ Vector store ────────────────▼───────────────────────────────┐
  │  InMemoryVectorStore — cosine scan over chunks                │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: a weak model (Gemma) hallucinated a filter key — `textContains` —
that no chunk carries. The original filter logic treated "key not present on
any chunk" as "nothing matches," so retrieval returned **empty**, and the agent
answered with no grounding. The fix: ignore filter keys absent from chunk
metadata. The regression test pins the fix.

## Structure pass

**Layers:** model output (hallucinated filter) → tool filter logic → vector
store results.

**Axis — failure containment: "where does a bad input get absorbed vs
propagated?"**

```
  One axis: "what happens to a hallucinated filter key?"

  ┌─ model ───────────────┐  emits filter { textContains: 'moon' }
  └───────────┬───────────┘
              │  seam ═══════ tool filter logic
  ┌─ tool   ▼─────────────┐  OLD: propagate → 0 results (failure escapes)
  │  filter step           │  NEW: absorb → ignore key → results survive
  └───────────┬───────────┘
  ┌─ store  ▼─────────────┐  returns ranked hits regardless
  └────────────────────────┘
```

**The seam:** the filter step inside the tool. The bug was that a failure (a
hallucinated key) propagated all the way to "empty results" instead of being
absorbed at the boundary. The regression test asserts the failure is now
contained.

## How it works

### Move 1 — the mental model

You know this from form validation: a user pastes garbage into an optional
field. The right behavior is to ignore the field, not to reject the whole form.
The bug here was the "reject the whole form" version — one unknown filter key
zeroed out *all* retrieval. The regression test is the assertion that the
garbage field is now ignored, not fatal.

```
  The regression test shape — assert the bug's symptom is gone

   trigger the exact bad input          assert the OLD symptom is absent
   ┌───────────────────────────┐        ┌──────────────────────────────┐
   │ filter:{ textContains:... }│  ───►  │ results.length > 0            │
   │ (a key no chunk carries)   │        │ (was 0 before the fix)        │
   └───────────────────────────┘        └──────────────────────────────┘
```

The strategy in one sentence: **reproduce the exact bad input, assert the old
symptom can't happen.**

### Move 2 — the walkthrough

**The test is named for the bug, not the feature.** Most tests in this file
describe a capability ("tool honors top_k"). This one describes a *defect* and
its fix, so the next reader knows it's load-bearing:

```ts
// packages/retrieval/test/search-knowledge-base-tool.test.ts:105
test('ignores filter keys absent from chunk metadata (a hallucinated filter does not wipe results)', async () => {
  const pipeline = await seededPipeline();
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
  const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });

  // A weak model invents a filter key no chunk carries. It must not zero out retrieval.
  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'how often does the moon orbit earth',
    filter: { textContains: 'moon' },   // ← the hallucinated key
  });
  const payload = result as { results: unknown[] };
  assert.ok(payload.results.length > 0,
    'hallucinated filter key should be ignored, not exclude everything');
});
```

The inline comment is the bug report. `textContains` looks plausible — a model
might reasonably guess that's a valid filter — but no chunk's `meta` has it.
The assertion `results.length > 0` is precisely the symptom inverted: before
the fix this was `0`; after, the unknown key is ignored and the moon chunk
still ranks.

**It's tested next to the legitimate filter, which proves the fix is
targeted.** Three lines up, `:91` asserts a *real* filter still works:

```ts
// packages/retrieval/test/search-knowledge-base-tool.test.ts:91
const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
  query: 'anything', filter: { docId: 'cooking' },
});
for (const r of payload.results) assert.equal(r.meta.docId, 'cooking');
```

So the fix isn't "ignore all filters" (that would break real filtering) — it's
"ignore *keys no chunk carries*." The pair of tests pins both halves: known
keys filter, unknown keys are ignored. That's the difference between fixing a
bug and papering over it.

**Same defensive theme runs through the tool.** `:77` ("tool floors top_k to
minTopK so a weak model cannot starve retrieval") is a sibling test for the
same class of problem: a weak model under-fetches with `top_k: 1`, the `minTopK`
floor lifts it back to 2. Both tests encode the same lesson — the tool must be
robust to a model that calls it slightly wrong, because Gemma *will* call it
slightly wrong.

```
  Layers-and-hops — the bug path, before and after

  ┌─ Model ──────┐ hop1: call tool with  ┌─ search_knowledge_base ──────┐
  │ Gemma         │  filter:{textContains}│  filter step:                │
  └───────────────┘ ────────────────────► │  OLD ─ key unknown → []      │
                                          │  NEW ─ key unknown → ignore  │
                                          └──────────────┬───────────────┘
                              hop2: query (unfiltered or partially)       │
                                                         ▼
                                          ┌─ InMemoryVectorStore ────────┐
                                          │ returns ranked hits           │
                                          └───────────────────────────────┘
```

### Move 2 variant — the kernel

The kernel of a good regression test: **the exact triggering input + an
assertion of the inverted symptom + a name that says "bug."** Remove the exact
input (test something adjacent instead) and you don't actually pin *this* bug.
Remove the symptom-inversion assertion (just check it doesn't throw) and the
bug can come back silently. Remove the descriptive name and the next engineer
deletes it as redundant with "tool honors a meta filter."

Optional hardening: the paired positive test (legitimate filter still works) —
not strictly required to pin the bug, but it's what stops the fix from being a
blunt over-correction.

### Move 3 — the principle

A regression test's job is narrow and absolute: make a specific past failure
impossible to reintroduce silently. The signal of a good one is that it reads
like a bug report — the input that broke it, the symptom that's now forbidden.
And the strongest version is paired with a positive test, so the fix is proven
*targeted*: the bad input is absorbed, the good input still works.

## Primary diagram

```
  Regression test from a real bug — full picture

  THE BUG:   Gemma hallucinates filter { textContains: 'moon' }
             old filter logic: unknown key → zero results → no grounding

  THE FIX:   ignore filter keys absent from chunk metadata

  THE TESTS (search-knowledge-base-tool.test.ts):
  ┌──────────────────────────────────────────────────────────────┐
  │  :105  hallucinated key  → results.length > 0   (symptom gone) │
  │  :91   legitimate docId  → every result.meta.docId == 'cooking'│
  │  :77   under-fetch top_k=1 → minTopK floor lifts to 2          │
  └──────────────────────────────────────────────────────────────┘
   pair proves the fix is targeted: bad input absorbed, good input works
```

## Elaborate

This is the textbook "write a failing test that reproduces the bug, then fix
it" loop — but the *cause* is specific to AI engineering: the defect came from a
model hallucinating an API it didn't have. That's a recurring class in
LLM-backed tools (the model invents a parameter, a tool name, a filter), and
the defensive posture — tolerate plausible-but-wrong tool calls — is itself a
pattern. The `minTopK` floor and the hallucinated-key tolerance are two
instances. Where this connects: study-ai-engineering treats "models hallucinate
tool arguments" as a prompt/agent reliability concern; here it's the concrete
test that the tool layer absorbs the hallucination instead of breaking on it.

## Interview defense

**Q: Walk me through a bug you caught with a test.**

> A weak local model — Gemma — called our retrieval tool with a filter key it
> invented, `textContains`, that no chunk carried. The old filter logic treated
> an unknown key as "nothing matches," so retrieval returned empty and the
> agent answered with no grounding. I fixed it to ignore filter keys absent
> from chunk metadata, and wrote a regression test named for the bug:
> hallucinated key in, assert results are non-empty. I paired it with a test
> that a *real* filter still narrows results — so the fix is targeted, not a
> blunt "ignore all filters."

```
  filter{textContains} → results > 0   (bug gone)
  filter{docId:cooking} → all cooking   (real filter still works)
```

Anchor: *reproduce the exact bad input; assert the inverted symptom; pair with
a positive test so the fix is targeted.*

## See also

- `02-fixture-replay-golden-master.md` — the drift-guarding kind of regression.
- `01-injectable-transport-seam.md` — the fake embedder that makes this tool
  test deterministic.
- `audit.md` lens 5 (error paths) and lens 7 (regression after a real bug).
- study-ai-engineering — model-hallucinated tool arguments as a reliability
  class.
