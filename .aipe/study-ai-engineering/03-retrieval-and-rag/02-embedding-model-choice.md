# Embedding model choice
> The one-way door · Industry standard

Here's the thing nobody tells you when you pick an embedding model: you're not picking a library you can swap on a Tuesday. You're picking the coordinate system your entire corpus lives in. Switch models and every vector you've stored is suddenly in the wrong space — your query points at coordinates that mean nothing to the old data. That's why aptkit treats the model choice as a *one-way door* and guards it with two loud assertions. Pick nomic, you've committed the corpus to nomic until you re-embed all of it.

## Zoom out, then zoom in

The model choice fixes one number — `dimension` — and that number propagates through every layer below it.

```
where the model choice locks the stack
┌──────────────────────────────────────────────────────────┐
│  ★ EmbeddingProvider   id="nomic-embed-text", dim=768  ★   │  ← the decision
└───────────────┬────────────────────────────────────────────┘
                │ dimension flows DOWN and must match
                ▼
┌──────────────────────────────────────────────────────────┐
│  assertWiring()   embedder.dimension === store.dimension   │  ← gate 1 (wiring)
├──────────────────────────────────────────────────────────┤
│  VectorStore.dimension   InMemory(768) / PgVector(768)     │
│  assertDimension()   every vector length === 768           │  ← gate 2 (every op)
└──────────────────────────────────────────────────────────┘
```

The model decision is one line — `readonly dimension = 768` — but it's the most expensive line to change in the whole retrieval package. aptkit's design accepts that and makes the cost *visible*: rather than letting a mismatch corrupt rankings silently, both gates throw. You can't accidentally walk back through this door.

## Structure pass

Pick the **failure** axis: what happens when the model behind the door changes but the corpus doesn't?

```
failure mode across the door
   index time                    query time
  ┌──────────────┐              ┌──────────────┐
  │ corpus @ 768  │              │ query @ 1536  │  (someone swapped the model)
  └──────┬───────┘              └──────┬───────┘
         │ stored                       │ search(vector, k)
         ▼                              ▼
  ┌─────────────────────────────────────────────┐
  │ ★ assertDimension: 1536 ≠ 768 → THROW ★      │  ← seam where it flips
  └─────────────────────────────────────────────┘
   without the gate: cosine over mismatched dims = garbage scores, silently
```

The seam is the dimension check. The danger isn't a crash — a crash is fine, you fix the wiring. The danger is the *silent* version: if cosine ran over vectors of different lengths (or worse, same length but different model), you'd get plausible-looking scores that rank nonsense. aptkit chose loud failure on purpose; the in-memory store's comment names it: "a silent mismatch corrupts ranking."

## How it works

**Move 1 — the decision tree.** aptkit's choice is local-first, and the tree is short:

```
embedding model decision tree (aptkit's path in ★)
                  need embeddings
                        │
         ┌──────────────┴──────────────┐
      privacy /                      best raw
      zero-cloud?                    quality?
         │                              │
       ★ YES ★                         no
         │                              │
   run locally?                   hosted API
         │                       (OpenAI 3-large,
       ★ Ollama ★                 Cohere, Voyage)
         │                              │
   ★ nomic-embed-text ★          1536+ dims, $/token,
   768-dim, free, fast            network on every embed
```

aptkit takes the left spine every time: **local, 768-dim, free, private, zero-cloud.** No token bill, no data leaving the laptop, no network on the hot path. The tradeoff is raw quality — a hosted 3072-dim model edges out nomic on hard benchmarks — but for a from-scratch pipeline you're optimizing for "build the whole thing with zero dependencies," and nomic delivers that.

**The dimension is the door.** The provider pins it as a constant, not a discovered value:

```ts
// packages/retrieval/src/ollama-embedding-provider.ts:39-40
readonly id = 'nomic-embed-text';
readonly dimension = 768;          // ← this is the door. change it = re-embed everything
```

```
the door: corpus and query share ONE coordinate system
   model A (768) ──► corpus vectors live in 768-space
   model A (768) ──► query vector lives in 768-space   ✓ comparable
   model B (1536)──► query vector lives in 1536-space  ✗ NOT comparable to corpus
```

**Gate 1 — at wiring time.** `assertWiring` runs the instant you build a pipeline, before any data flows:

```ts
// packages/retrieval/src/pipeline.ts:22-29
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {   // door check
    throw new Error(
      `dimension mismatch: embedder "${wiring.embedder.id}" is ${wiring.embedder.dimension}-dim ` +
        `but store is ${wiring.store.dimension}-dim — re-index the corpus with a matching provider`,
    );                                                          // ← tells you the fix
  }
}
// createRetrievalPipeline (:73-81) calls this BEFORE binding index/query
```

The error message names the cure: "re-index the corpus with a matching provider." That's the migration, spelled out in the throw.

**Gate 2 — at every operation.** The store re-checks each vector's length on upsert and search:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:36-42
private assertDimension(vector: number[], label: string): void {
  if (vector.length !== this.dimension) {                       // per-vector, every call
    throw new Error(
      `dimension mismatch: ${label} has length ${vector.length}, store expects ${this.dimension}`,
    );
  }
}
// called in upsert (:20) and search (:26) — belt and suspenders
```

Why two gates? Gate 1 catches misconfiguration. Gate 2 catches a *provider* that returns the wrong shape at runtime — a model update, a malformed response. Defense in depth on the thing that corrupts silently.

**Move 3 — the principle.** The model choice is the one-way door of RAG. Everything else in the stack is reversible: re-chunk, swap the store, change `topK`, all cheap. The embedding model is not — changing it invalidates every stored vector, so the migration is "re-embed the entire corpus," not "change a config flag." Design for that: pin the dimension, assert it loudly, and treat a model upgrade as a corpus rebuild with a cutover, never an in-place edit.

## Primary diagram

```
the one-way door, with both gates
   PICK MODEL ──► dimension = 768 ──┐
                                     │ flows down
                                     ▼
   wiring ──► [assertWiring] ── 768==768? ──► pipeline lives
                  │ NO                              │
                  ▼                                 ▼ index/query
              THROW (config)                  [assertDimension]
                                              len==768 per vector?
                                                  │ NO
                                                  ▼
                                            THROW (runtime)
   to walk back through the door:  re-embed ALL chunks with the new model
```

Two gates, two failure classes (config vs runtime), one cure (re-embed the corpus).

## Elaborate

The "one-way door" framing is Amazon's (Bezos's reversible-vs-irreversible-decisions memo) — embedding choice is the canonical irreversible one in RAG. Adjacent: **Matryoshka embeddings** (models like nomic-v1.5 and OpenAI 3 let you truncate dims — a *partial* escape hatch from the door), and **MTEB**, the benchmark you'd consult to justify a model pick. Note buffr already carries the migration metadata: `agents.chunks.embedding_model` (`sql/001_agents_schema.sql:23`) stamps each row with the model that produced it — the slot a re-embed migration reads to know what's stale (file 09). Read next: `01-embeddings.md` (what the model produces) and `09-stale-embeddings.md` (the freshness side of the same door).

## Project exercises

### Document and script the re-embed migration path

- **Exercise ID:** `EX-RAG-02a`
- **What to build:** A migration script + runbook that re-embeds buffr's `agents.chunks` with a new model: read every chunk's `content`, re-embed with the new provider, upsert with the new vector and updated `embedding_model`, behind a feature flag / new `app_id` namespace so you can cut over atomically.
- **Why it earns its place:** The one-way door is only survivable if the migration is *written down and tested*. The error message says "re-index the corpus" — this exercise turns that sentence into a runnable, reversible procedure. Phase 2B: making the irreversible decision reversible-with-effort.
- **Files to touch:** new script under `buffr/src/` (or `buffr/scripts/`); reads `agents.chunks` (`buffr/sql/001_agents_schema.sql:14-25`); reuses `PgVectorStore.upsert` (`buffr/src/pg-vector-store.ts:38-65`).
- **Done when:** running the script against a seeded DB produces a parallel set of re-embedded chunks under a new model tag, queries against the new namespace return sane rankings, and the old namespace is untouched until cutover.
- **Estimated effort:** `1–2 days`

### Add a dimension-mismatch regression test at the tool seam

- **Exercise ID:** `EX-RAG-02b`
- **What to build:** A test proving `createSearchKnowledgeBaseTool` over a pipeline whose embedder/store dimensions disagree fails at wiring, not mid-query.
- **Why it earns its place:** The gates exist; pin them so a future refactor that moves the assert can't regress to a silent mismatch.
- **Files to touch:** `packages/retrieval/src/` test files alongside `pipeline.ts`; exercise `assertWiring` (`packages/retrieval/src/pipeline.ts:22-29`).
- **Done when:** the test asserts the throw message includes both dimensions and the "re-index" hint.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Why does changing the embedding model invalidate the whole corpus — can't you just embed new docs with the new model?**

```
mixed-model corpus = mixed coordinate systems
  old chunks @ model A      new chunks @ model B
       ●  ●  ●                   ◆  ◆  ◆
        \  query @ B  →  close to ◆, random vs ●
   cosine across A and B is meaningless — rankings interleave garbage
```

Anchor: cosine only compares vectors from the same model; a mixed corpus ranks new and old chunks on incomparable scales. It's all-or-nothing — re-embed everything or none.

**Q: Two dimension gates seems redundant. Why both?**

```
assertWiring  → catches WRONG WIRING (config, once, at startup)
assertDimension → catches WRONG SHAPE (runtime, every vector)
   different failures, same corruption if missed
```

Anchor: the wiring gate catches a misconfigured pipeline; the per-vector gate catches a provider that returns the wrong shape at runtime. Both guard the one thing that fails silently — corrupted rankings.

## See also

- [01-embeddings.md](01-embeddings.md) — what the model produces
- [04-vector-databases.md](04-vector-databases.md) — where `dimension` is enforced on storage
- [09-stale-embeddings.md](09-stale-embeddings.md) — `embedding_model` and freshness
