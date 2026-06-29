# Query rewriting & HyDE
> Query transformation · Industry standard

The user's query and your indexed text are written by different people for different reasons — and they often don't share vocabulary or shape. The user types "why is my thing slow"; your docs say "latency degradation under load." Dense retrieval helps, but there's a gap. Query transformation closes it by rewriting the query *before* it hits the retriever. Two flavors: **query rewriting** (an LLM rewrites the messy query into a clean, retrieval-friendly one) and **HyDE** (the LLM writes a *fake answer* and you embed *that*, because a hypothetical answer looks more like real corpus passages than a question does). aptkit does neither — `queryKnowledgeBase` embeds the raw query as-is. This is `not yet exercised`, and the cost to add it is one extra LLM call.

## Zoom out, then zoom in

Query transformation would sit at the very top of the query path, before the embed.

```
the query path, with the transform gap
┌──────────────────────────────────────────────────────────┐
│  user query (messy, conversational, underspecified)         │
└───────────────┬────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│  ★ query transform ★   rewrite / HyDE   ✗ not yet exercised │  ← the gap
└───────────────┬────────────────────────────────────────────┘
                ▼  (today: raw query goes straight here)
┌──────────────────────────────────────────────────────────┐
│  queryKnowledgeBase → embed → store.search   (exists ✓)     │
└──────────────────────────────────────────────────────────┘
```

Today the raw user query flows straight into `embed` at `pipeline.ts:56`. There's no transform step — what the user types is what gets vectorized. That's fine when the query is already well-formed, but conversational or vocabulary-mismatched queries embed into a region of the space that's just *near* the right answers instead of *on* them. The transform's job is to move the query vector closer to where the answers live, before search ever runs.

## Structure pass

Pick the **cost** axis: what does the transform buy, and what does it spend?

```
cost vs benefit of the transform
  NO TRANSFORM (aptkit today)        WITH TRANSFORM
  ┌──────────────────────┐          ┌──────────────────────────┐
  │ embed(raw query)       │          │ LLM call → rewrite/HyDE   │
  │ 1 embed call           │          │ THEN embed(transformed)   │
  │ fast, cheap            │          │ +1 LLM call, +latency     │
  │ vocabulary gap remains │          │ vocabulary gap closed     │
  └──────────────────────┘          └──────────────────────────┘
       ▲ seam: an extra LLM call on the hot path — is the recall worth it? ▲
```

The seam is that extra LLM call. It sits on the *query hot path*, so every search now waits on a generation before it can even start retrieving — real latency, real tokens. You spend that to close the query/corpus vocabulary gap. It's worth it when your queries are genuinely messy (conversational agents, voice, vague users) and not worth it when they're already keyword-clean. Like reranking (file 07), you measure before you add it.

## How it works

**Move 1 — two transforms, same slot.** Both run before embed; they differ in *what they produce*:

```
query rewriting vs HyDE
  QUERY REWRITING                    HyDE (Hypothetical Document Embeddings)
  ┌──────────────────────┐          ┌──────────────────────────────┐
  │ "why is my thing slow"│          │ "why is my thing slow"         │
  │        ↓ LLM           │          │        ↓ LLM: "write the answer"│
  │ "causes of high        │          │ "Slowness is usually caused by │
  │  latency under load"   │          │  CPU saturation, lock          │
  │ (a better QUERY)       │          │  contention, or..." (fake ANSWER)│
  │        ↓ embed         │          │        ↓ embed the FAKE ANSWER  │
  │ search                 │          │ search                          │
  └──────────────────────┘          └──────────────────────────────┘
   embeds a cleaner question          embeds something shaped LIKE the corpus
```

The HyDE insight is counterintuitive and clever: your corpus is made of *answers* (passages), so a query embedded as a question lands in question-space, slightly off from answer-space. But a *hypothetical answer* — even a wrong one — is shaped like the real passages, so it embeds right into the neighborhood of the true answer. You don't care if the fake answer is factually correct; you only use its *vector* to retrieve the real one.

**Move 2 — where it plugs in.** aptkit's `queryKnowledgeBase` is the exact insertion point. `not yet exercised`:

```ts
// packages/retrieval/src/pipeline.ts:50-59  (the slot, TODAY)
export async function queryKnowledgeBase(query, wiring, topK = 5): Promise<VectorHit[]> {
  assertWiring(wiring);
  const [vector] = await wiring.embedder.embed([query]);  // ← raw query embedded as-is
  if (!vector) return [];                                 //   NO transform happens here
  return wiring.store.search(vector, topK);
}
```

```
proposed transform wrapper (pseudocode — DOES NOT EXIST)
function queryWithTransform(query, wiring, transform, topK = 5):
    effectiveQuery = transform                       # optional step
        ? await transform.run(query)                 # LLM rewrites or writes fake answer
        : query                                       # falls back to raw (today's behavior)
    [vector] = await wiring.embedder.embed([effectiveQuery])  # embed the TRANSFORMED text
    return wiring.store.search(vector, topK)
```

The cleanest design makes the transform *optional and injectable* — same move as the embedding transport. When absent, behavior is identical to today; when present, it rewrites or HyDE's before the embed. The store and the search tool never change.

**HyDE's embed target.** The one subtlety: HyDE embeds the *generated answer*, not the query — so the thing you pass to `embed` is LLM output, which means HyDE inherits the LLM's latency *and* a small risk the fake answer drifts off-topic:

```
HyDE failure mode to watch
  good HyDE:  query → plausible on-topic fake answer → embeds near real answers ✓
  bad HyDE:   query → LLM hallucinates an off-topic answer → embeds into the WRONG
                                                              neighborhood → worse recall
   mitigation: average the query vector AND the HyDE vector (hedge the bet)
```

A common hedge is to embed *both* the raw query and the hypothetical answer and average the vectors — so a bad hallucination can't fully drag retrieval off course.

**Move 3 — the principle.** Query transformation trades an LLM call for closing the vocabulary/shape gap between how users ask and how your corpus answers. It's optional by design — the raw-query path must stay the default, because most well-formed queries don't need it and you don't want to pay a generation on every search. Add it where queries are demonstrably messy, measure the recall lift against the latency cost (same gate discipline as reranking), and for HyDE, hedge against hallucinated fake-answers by blending in the original query vector.

## Primary diagram

```
query transformation (the buildable target)
   user query "why is my thing slow"
        │
        ▼  optional transform (LLM call) ─── falls back to raw if absent
   ┌──────────────────────┬──────────────────────────┐
   │ REWRITE               │ HyDE                      │
   │ → cleaner query        │ → fake answer passage     │
   └──────────┬───────────┴────────────┬─────────────┘
              ▼                          ▼
        embed(rewritten)          embed(fake answer)   [optionally avg with embed(query)]
              └────────────┬─────────────┘
                           ▼
                   store.search(vector, k)   ← unchanged
```

One optional LLM step moves the query vector closer to the answers before search runs; everything downstream is untouched.

## Elaborate

HyDE is Gao et al., 2022 ("Precise Zero-Shot Dense Retrieval without Relevance Labels") — the surprising result that embedding a hallucinated answer beats embedding the query. Query rewriting shows up everywhere agents hold conversations: **multi-query** (generate N rewrites, retrieve for each, union the results), **step-back prompting** (rewrite to a more general question first), and **conversational query rewriting** (resolve "it"/"that" against chat history before retrieving — directly relevant to aptkit's conversation memory in sub-section 04). The tradeoff is always the same: more LLM calls, more recall, more latency. Read next: `07-reranking.md` (the other measure-first, LLM-cost retrieval add-on) and `11-rag.md` (the loop the transform feeds).

## Project exercises

### Add an optional query-rewrite step before queryKnowledgeBase

- **Exercise ID:** `EX-RAG-08a`
- **What to build:** A `QueryTransform { run(query): Promise<string> }` contract and a `queryWithTransform` wrapper that runs an injectable rewrite/HyDE step before embedding, defaulting to the raw query when absent.
- **Why it earns its place:** It makes the transform a clean, optional adapter (like the embedding transport) rather than a hardcoded branch, and gives aptkit a real lever for messy conversational queries — exactly what a chat agent produces. Case B. Phase 2B.
- **Files to touch:** new `packages/retrieval/src/query-transform.ts`; wrap `queryKnowledgeBase` (`packages/retrieval/src/pipeline.ts:50-59`); reuse the Gemma chat transport pattern for the LLM call (mirrors `OllamaEmbeddingProvider`'s injectable transport).
- **Done when:** a query with a deterministic stub rewriter retrieves a chunk the raw query misses, the raw-query path is unchanged when no transform is wired, and a test pins both.
- **Estimated effort:** `1–4hr`

### Implement HyDE with a query/hypothesis vector blend

- **Exercise ID:** `EX-RAG-08b`
- **What to build:** A HyDE `QueryTransform` that generates a hypothetical answer, embeds it, and averages it with the raw-query embedding to hedge hallucination, returning the blended vector to `store.search`.
- **Why it earns its place:** HyDE is the non-obvious, high-signal transform, and the blend is the production-grade detail that stops a bad fake answer from wrecking recall. Case B; depends on `EX-RAG-08a`. Phase 2B.
- **Files to touch:** extend `packages/retrieval/src/query-transform.ts`; needs a vector-returning variant of the query path in `packages/retrieval/src/pipeline.ts`.
- **Done when:** on a vocabulary-mismatched fixture, HyDE-blend beats raw-query recall, and a degenerate hallucinated answer doesn't drop recall below raw (the blend saves it).
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: HyDE embeds a hallucinated answer that might be factually wrong. How is that not garbage in, garbage out?**

```
corpus = ANSWERS (passages)         query = a QUESTION (different shape)
  embed(question) → lands in question-space, off from answers
  embed(fake answer) → lands in ANSWER-space → near the real answer
   you use the fake answer's VECTOR, never its words — facts don't matter
```

Anchor: HyDE exploits *shape*, not facts — a hypothetical answer looks like corpus passages, so its vector retrieves the real ones; you discard the fake text entirely.

**Q: When should you NOT add a query transform?**

```
queries already clean (keyword-y, well-formed) → transform adds latency, no recall lift
   every search now waits on an LLM call on the hot path
```

Anchor: the transform costs an LLM call per query; you add it only when queries are measurably messy enough that the recall gain beats the latency — measure first, same as reranking.

## See also

- [07-reranking.md](07-reranking.md) — the other measure-first, LLM-cost add-on
- [01-embeddings.md](01-embeddings.md) — what the transformed text becomes
- [11-rag.md](11-rag.md) — the retrieve-then-generate loop this feeds
