# Bug to regression test — the hallucinated filter

**Industry name:** regression test (a defect turned into a permanent guard);
defends an invariant against a recurring failure mode. Type label: Industry
standard.

## Zoom out, then zoom in

The other patterns guard correctness in general. This one guards against a
*specific bug that already happened* — and the bug is interesting because it's
an AI-shaped failure mode, not a classic logic error.

```
  Zoom out — where the guard sits

  ┌─ agent (Gemma — a weak local model) ─────────────────────┐
  │  decides to call search_knowledge_base — but may invent   │
  │  a `filter` key no chunk actually carries                 │
  └──────────────────────────┬───────────────────────────────┘
                             │ tool call w/ {filter:{textContains:'moon'}}
  ┌─ search_knowledge_base tool ▼────────────────────────────┐
  │  ★ THE GUARD ★ ignore filter keys absent from chunk meta │
  │  (a hallucinated key must NOT zero out results)           │
  └──────────────────────────┬───────────────────────────────┘
                             │ filtered search
  ┌─ VectorStore ─────────────▼──────────────────────────────┐
  │  cosine ranking over chunks                               │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** A weak model (Gemma has no native tool-calling, `02`) can invent a
filter argument that looks plausible but matches nothing — `{textContains:
'moon'}` when chunks only carry `docId`/`chunkIndex`/`text`. The naive
implementation applies the filter, matches zero chunks, and returns empty
results — so the agent silently retrieves nothing and answers ungrounded. The
fix: ignore filter keys no chunk carries. The test pins it. The question: *how
do you keep a known bug from coming back?* Reproduce it in a test that fails on
the old behavior and passes on the fix.

## Structure pass

**Layers:** model (untrusted args) → tool (the guard) → store.
**One axis — trust in the tool's arguments:**

```
  Axis: are the tool arguments trustworthy?

  ┌─ model ─┐   seam    ┌─ tool ──────────────┐
  │ invents │ ═══╪════►  │ TREATS ARGS AS      │
  │ a filter│  (flips)   │ UNTRUSTED — ignores │
  │ key     │            │ keys no chunk has   │
  └─────────┘            └─────────────────────┘
```

The trust axis flips at the tool boundary: the model's arguments are untrusted
input (it's a weak model that hallucinates), and the tool's job is to be robust
to them — the same way a server treats client input as hostile. The guard is
where that flip is enforced; the regression test is what keeps the guard.

## How it works

### Move 1 — the mental model

You've written defensive input handling before: a query-param parser that
ignores unknown params instead of 500-ing, so a client sending `?foo=bar`
doesn't break the endpoint. Same shape, but the "client" is a hallucinating LLM.
The bug was the *non-defensive* version — an invented filter key wiped the
results instead of being ignored.

```
  The pattern — bug → reproducing test → fix → permanent guard

  1. observe:  Gemma invents filter {textContains:'moon'} → 0 results
  2. write:    test that calls the tool with that exact filter
  3. assert:   results.length > 0  (fails on old code, passes on fix)
  4. keep:     the test stays forever — the bug can't silently return
```

### Move 2 — the walkthrough

#### The reproducing test

The test recreates the exact hallucination and asserts the defensive behavior:

```ts
// packages/retrieval/test/search-knowledge-base-tool.test.ts:105
test('ignores filter keys absent from chunk metadata (a hallucinated filter does not wipe results)', async () => {
  const pipeline = await seededPipeline();          // 2 chunks: 'space', 'cooking'
  const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
  const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });

  // A weak model invents a filter key no chunk carries. It must not zero out retrieval.
  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'how often does the moon orbit earth',
    filter: { textContains: 'moon' },              // ← the hallucinated key
  });
  const payload = result as { results: unknown[] };
  assert.ok(payload.results.length > 0, 'hallucinated filter key should be ignored, not exclude everything');
});
```

The chunks carry `docId`/`chunkIndex`/`text` — never `textContains`. On the old
code, applying `{textContains:'moon'}` matched zero chunks and returned `[]`. On
the fixed code, the unknown key is skipped, so the cosine ranking proceeds and
the moon doc comes back. The assertion `results.length > 0` is the tripwire: it
fails on the regression and passes on the fix.

#### Contrast with the legitimate filter — same test file

Right above it, the test proves the filter *does* work when the key is real
(`:91`):

```ts
// search-knowledge-base-tool.test.ts:91
const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
  query: 'anything', filter: { docId: 'cooking' },   // ← a REAL key
});
for (const r of payload.results) assert.equal(r.meta.docId, 'cooking');
```

The pair is the whole lesson: a *real* filter key (`docId`) is honored and
narrows results; a *hallucinated* key (`textContains`) is ignored and doesn't.
The guard distinguishes "filter the model meant" from "filter the model
invented" by checking whether any chunk actually carries the key.

#### The sibling guard — the `minTopK` floor

The same file tests a second weak-model defense (`:77`): a model that
under-fetches with `top_k: 1` gets floored back up to `minTopK: 2`, "so a weak
model cannot starve retrieval." Same family of bug — a weak model making a poor
tool-call decision — same family of fix: the tool is robust to bad arguments.
Two guards, one principle.

### Move 2 variant — the load-bearing skeleton

Kernel of a regression test: **a faithful reproduction of the failing input + an
assertion that distinguishes old behavior from fixed + permanence (it stays in
the suite).** What breaks without each:

- **Drop the faithful reproduction** → the test passes but doesn't actually
  exercise the bug; the defect can return undetected. The exact filter
  (`{textContains:'moon'}`) is what makes it faithful.
- **Drop the discriminating assertion** → if the assert passes on *both* old and
  fixed code, it's not guarding anything. `results.length > 0` specifically
  fails on the empty-result bug.
- **Drop permanence** → a one-off manual check doesn't stop the bug from being
  reintroduced by the next refactor. Living in `npm test` is the guard.

### Move 3 — the principle

Every bug is a missing test. The fix isn't done when the code works again — it's
done when there's a test that fails on the old behavior, so the same defect
can't return silently. For AI systems, the highest-value regression tests guard
the *boundary* against bad model behavior: the model is untrusted input, and the
deterministic code around it (the tool, the parser, the validator) must be
robust to whatever the model invents — and a test pins that robustness.

## Primary diagram

```
  Bug → regression test — full picture

  ┌─ the bug (observed) ──────────────────────────────────────┐
  │  Gemma calls search w/ filter {textContains:'moon'}        │
  │  → naive tool applies it → 0 chunks match → empty results  │
  │  → agent answers ungrounded (silent failure)               │
  └──────────────────────────┬─────────────────────────────────┘
                             │ fix: ignore keys no chunk carries
  ┌─ the guard (in the tool) ▼─────────────────────────────────┐
  │  real key (docId) → applied & narrows                       │
  │  invented key (textContains) → ignored, ranking proceeds    │
  └──────────────────────────┬─────────────────────────────────┘
                             │ pinned by
  ┌─ the regression test (permanent) ▼─────────────────────────┐
  │  assert results.length > 0 on the hallucinated filter       │
  │  + assert real filter still narrows (the contrast pair)     │
  │  lives in npm test → the bug cannot silently return         │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

Regression testing is the oldest discipline here, but the *failure mode* is new:
the bug originates in model behavior (hallucinating a tool argument), not in a
developer's logic error. That's why the fix lives in the deterministic boundary
(the tool) and the test is a normal `node --test` case — the model's
hallucination is reproduced as a literal argument, and the deterministic guard
is asserted. No eval needed: "does the tool ignore unknown filter keys" is a
hard `equals`-style question, fully in study-testing's half of the seam.

This connects to study-debugging-observability: the bug was likely *found*
because the trace showed an empty retrieval followed by an ungrounded answer.
The trace surfaces the symptom; the regression test prevents the recurrence.

## Interview defense

**Q: Tell me about a bug you turned into a test.**
A weak local model (Gemma) hallucinated a `filter` argument to the
knowledge-base search tool — a key no chunk carried. The naive tool applied it,
matched nothing, and returned empty results, so the agent answered without
grounding. The fix made the tool ignore filter keys absent from chunk metadata.
The regression test (`search-knowledge-base-tool.test.ts:105`) calls the tool
with that exact hallucinated filter and asserts `results.length > 0` — it fails
on the old behavior, passes on the fix, and stays in the suite.

```
  invented key {textContains} → 0 results (bug)
  fix: ignore unknown keys → results > 0 (guard) → test pins it forever
```

Anchor: *the model is untrusted input; the deterministic tool around it must be
robust to what the model invents, and the test guards that robustness.*

**Q: What makes a regression test actually guard something?**
It has to fail on the old behavior. If the assertion passes on both the buggy
and fixed code, it guards nothing. Here `results.length > 0` is chosen
specifically because the bug returned an *empty* array — the assertion
discriminates the two states.

```
  good regression test: PASSES on fix, FAILS on the original bug
  bad one: passes on both → guards nothing
```

Anchor: *the assertion must discriminate old from new, or it's decoration.*

## See also

- `02-injected-transport.md` — why Gemma (the weak model) hallucinates tool args
  in the first place.
- `04-deterministic-fake-embedder.md` — the fake embedder this test uses to
  reproduce the bug deterministically.
- `audit.md` lens 5 (error paths) and lens 1 (the named bug→regression example).
- study-debugging-observability — the trace that surfaces the symptom.
