# Embedding model choice — the one-way door

**Subtitle:** Model selection · which embedder, and the cost of changing it · *Language-agnostic*

## Zoom out, then zoom in

Picking the embedding model is the one retrieval decision you cannot cheaply undo.
It sits at the same seam as the embedder, but the consequence ripples down into the
store: every vector in the corpus carries the fingerprint of the model that made
it, and they all have to match.

```
  Zoom out — the choice ripples down the stack

  ┌─ Choice: which EmbeddingProvider? ──────────────────────────┐
  │  ★ nomic-embed-text, 768-dim, local via Ollama ★            │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
              embeds at 768    │
  ┌─ Corpus (every chunk) ─────▼────────────────────────────────┐
  │  v0[768]  v1[768]  v2[768] …  all in ONE embedding space     │
  └───────────────────────────┬─────────────────────────────────┘
              query must match │
  ┌─ Query ────────────────────▼────────────────────────────────┐
  │  embedded by the SAME 768-dim provider, or cosine is garbage │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You have made one-way decisions before — pick a primary key type, a
database collation, an id scheme, and migrating off it later means rewriting every
row. The embedding model is that kind of decision. aptkit picks
nomic-embed-text for a specific reason: it runs locally through Ollama with no API
key and no cloud bill, which fits the "build the whole pipeline with zero cloud"
constraint. The price of that choice is the door it closes behind you.

## Structure pass

**Layers.** Choice (which provider) → embedding space (a 768-dim coordinate system)
→ corpus (every chunk lives in that space) → query (must enter the same space).

**Axis — lifecycle.** Trace a corpus across its life: indexed once at 768-dim, queried
thousands of times at 768-dim, and — if you ever switch models — re-indexed *from
scratch* at the new dimension. There is no incremental migration. The axis "can I
mix old and new vectors?" is always *no*: a corpus is single-model by construction.

**Seam.** The dimension guard `assertWiring` (`pipeline.ts:22`). This is where the
one-way door is enforced: if `embedder.dimension !== store.dimension`, it throws at
wiring time with a message that literally says "re-index the corpus." The seam
turns a silent ranking-corruption bug into a loud startup failure.

## How it works

### Move 1 — the mental model

You know that two strings hashed by different hash functions can't be compared —
the bucket numbers are meaningless across functions. Two embeddings from different
models are exactly that: numbers in incompatible coordinate systems. A 768-dim
nomic vector and a 1536-dim OpenAI vector don't just differ in length; even at the
same length the axes mean different things. You cannot cosine-compare across models.

```
  Two models, two spaces — no shared ruler

  nomic space (768)              OpenAI space (1536)
  ┌──────────────┐               ┌──────────────────┐
  │ "auth bug" ● │               │ "auth bug"   ●   │
  │  dim 0..767  │   NO MEANING   │  dim 0..1535     │
  └──────────────┘ ◄── cosine ──► └──────────────────┘
        the axes don't line up — comparison is noise
```

### Move 2 — the choice and its enforcement

**The choice: local, zero-cloud, 768-dim.** `OllamaEmbeddingProvider` hard-codes the
decision (`ollama-embedding-provider.ts:39`):

```ts
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'nomic-embed-text';
  readonly dimension = 768;          // FIXED by the model — not a tuning knob
  // ...
}
```

`id` and `dimension` are `readonly` because they are not configuration — they are
facts about the model. nomic was chosen for local-first operation: Ollama serves it
on localhost, no key, no per-call cost.

```
  Why nomic-embed-text

  ┌─ constraint: zero cloud, no API key ─┐
  │  nomic via Ollama  ── local, free    │ ◄── chosen
  │  OpenAI / Voyage   ── key + per-call │ ◄── later drop-in (not yet exercised)
  └──────────────────────────────────────┘
```

**The enforcement: fail loud at the seam.** `assertWiring` (`pipeline.ts:22`) runs
before any index or query and rejects a dimension mismatch:

```ts
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(
      `dimension mismatch: embedder "${wiring.embedder.id}" is ${wiring.embedder.dimension}-dim ` +
        `but store is ${wiring.store.dimension}-dim — re-index the corpus with a matching provider`,
    );
  }
}
```

Both stores re-check every vector too (`in-memory-vector-store.ts:36`,
`pg-vector-store.ts:32`). The mismatch is treated as a *wiring bug*, not a runtime
input — caught at startup, not in production.

```
  The dimension guard — one-way door, locked loud

  createRetrievalPipeline(wiring)
        │ assertWiring
        ▼
  embedder.dim 768  ==  store.dim 768  ─► OK, proceed
  embedder.dim 768  !=  store.dim 1536 ─► THROW "re-index the corpus"
```

**The fingerprint that survives the choice.** buffr's chunks table records which
model embedded each row — `embedding_model text not null default
'nomic-embed-text:v1.5'` (`/Users/rein/Public/buffr/sql/001_agents_schema.sql:23`).
That column is the hook: it lets you detect a corpus embedded by an old model and
schedule a re-embed (the staleness story, `09-stale-embeddings.md`).

### Move 2.5 — current state vs future state

aptkit runs only nomic today. An OpenAI or Voyage adapter is a `not yet exercised`
drop-in — and crucially, swapping it is *not* free, because the corpus changes
dimension.

```
  Phase A (now)                    Phase B (switch models)
  ┌──────────────────────┐         ┌────────────────────────────┐
  │ nomic, 768-dim        │         │ OpenAI, 1536-dim            │
  │ corpus all 768        │  NOT a  │ corpus must be RE-EMBEDDED  │
  │ query 768             │ swap →  │ every chunk re-indexed      │
  └──────────────────────┘         │ no incremental migration    │
   provider abstraction is real    └────────────────────────────┘
   BUT the vectors are not portable across the door
```

The provider is swappable in *code* (one adapter). The *data* is not portable —
that asymmetry is the whole lesson.

### Move 3 — the principle

A model abstraction makes the code swappable but not the corpus. Choose the
embedding model for the deployment you actually have (local-first → nomic), record
the model on every row so you can detect drift, and guard the dimension at the seam
so a wrong swap fails at startup instead of silently ranking noise. Switching models
is a re-index, not a config flip — budget for it accordingly.

## Primary diagram

```
  The one-way door

  decision: nomic-embed-text, 768-dim, local
        │
        ▼  index whole corpus at 768
  ┌─ corpus: every chunk in nomic's 768-dim space ─┐
  │  embedding_model = 'nomic-embed-text:v1.5'      │ ◄── fingerprint per row
  └───────────────────────────┬────────────────────┘
        query at 768 ──────────┘  guarded by assertWiring (pipeline.ts:22)

  switch to a 1536-dim model? ─► re-embed EVERY chunk. no partial migration.
```

## Elaborate

The "build vs buy" instinct says reach for the best embedding model. At aptkit's
scale the better instinct is "what runs with zero infrastructure," because the
retrieval quality ceiling is set by chunking and ranking long before the model
matters. nomic local clears the bar and costs nothing per query. When the corpus
and quality bar grow, the `embedding_model` column
(`/Users/rein/Public/buffr/sql/001_agents_schema.sql:23`) and the dimension guard
make the upgrade a deliberate, detectable re-index rather than a silent corruption.
Read `01-embeddings.md` for what the 768-dim vector is and `09-stale-embeddings.md`
for using the fingerprint column to detect model drift.

## Project exercises

### Add an OpenAI embedding adapter and prove the door is one-way
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a second `EmbeddingProvider` (e.g. `OpenAIEmbeddingProvider`,
  `dimension = 1536`) and a test that wires it to a 768-dim store and asserts
  `assertWiring` throws.
- **Why it earns its place:** it makes the one-way door concrete — a passing test
  that the wrong swap fails loud is the clearest proof you understand the dimension
  invariant interviewers probe for.
- **Files to touch:** a new `packages/retrieval/src/openai-embedding-provider.ts`,
  `packages/retrieval/src/contracts.ts` (implement existing type), a new test in
  `packages/retrieval/test/`.
- **Done when:** the adapter passes the `EmbeddingProvider` contract and a test
  confirms a 1536-dim embedder against a 768-dim store throws "re-index the corpus."
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Can you swap embedding models without re-indexing?"**
No. The corpus lives in one model's coordinate space; a different model produces
incompatible vectors, often at a different dimension. Swapping the *adapter* is one
file, but the *data* must be re-embedded from scratch — there's no incremental
migration. aptkit guards this with `assertWiring` (`pipeline.ts:22`), which throws
"re-index the corpus" on a dimension mismatch, and records `embedding_model`
per chunk so drift is detectable.

```
  swap adapter = 1 file        swap model = re-embed every chunk
  the door is one-way: corpus and query must share one space
```
Anchor: *the provider is swappable; the corpus is not — switching models is a re-index.*

**Q: "Why nomic-embed-text specifically?"**
Local-first, zero cloud: Ollama serves it on localhost with no API key and no
per-call cost, which fits aptkit's "build the whole pipeline with zero
infrastructure" constraint. The 768 dimension is fixed by the model, not chosen.
OpenAI/Voyage are later drop-ins for when the quality bar outgrows local — a
deliberate re-index, not a default.

```
  constraint (zero cloud) ─► nomic local ─► no key, no bill, 768-dim fixed
```
Anchor: *choose the embedder for the deployment you have — local-first means nomic.*

## See also

- `01-embeddings.md` — what the 768-dim vector means
- `04-vector-databases.md` — the store that carries the dimension
- `09-stale-embeddings.md` — the `embedding_model` column and model drift
- `11-rag.md` — the dimension guard inside the pipeline
- `01-llm-foundations/08-provider-abstraction.md` — swappable code vs non-portable data
