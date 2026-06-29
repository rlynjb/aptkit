# Self-Corrective RAG

**Industry standard.** "Self-RAG," "CRAG," "corrective RAG," "relevance grading." Type label: reasoning pattern (a grader between retrieval and generation). **In this codebase: partially.** aptkit has no relevance *grader* between retrieval and generation — but it has two guards built for the same problem the grader solves: a weak model starving or poisoning its own retrieval. The `minTopK` floor and the hallucination-tolerant `matchesFilter` are corrective-RAG-in-spirit, applied at the tool boundary instead of as a grading step.

## Zoom out, then zoom in

Self-corrective RAG adds a check between retrieving and generating: grade whether the chunks are relevant and grounded; if not, fall back (rewrite the query, widen the search, escalate). aptkit doesn't grade chunks — but it does defend the retrieval call against a weak local model that would otherwise sabotage it. Same goal (don't let a bad retrieval poison the answer), different layer.

```
  Zoom out — aptkit's corrective guards live in the TOOL, not a grader

  ┌─ Loop layer ─────────────────────────────────────────────┐
  │  model calls search_knowledge_base(query, top_k, filter)  │
  └───────────────────────────┬──────────────────────────────┘
                              │ args may be weak-model garbage
  ┌─ Tool layer (the guard) ──▼──────────────────────────────┐
  │  ★ minTopK floor ★  + ★ hallucination-tolerant filter ★   │ ← we are here
  │  search-knowledge-base-tool.ts:51, :101                  │
  └───────────────────────────┬──────────────────────────────┘
                              │ corrected args
  ┌─ Retrieval layer ─────────▼──────────────────────────────┐
  │  pipeline.query → ranked hits                             │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: where do you catch a bad retrieval?** Canonical self-RAG catches it *after* retrieval, with a grader. aptkit catches it *during the call*, by defending the arguments. The seam: corrective RAG's grader sits between retrieve and generate; aptkit's guards sit between the model's tool-call and the pipeline. Both protect the same thing — that retrieval success isn't answer success — at different points.

## How it works

### Move 1 — the mental model

The canonical pattern adds a grader; aptkit adds two argument guards. The shared insight: **a chunk coming back is not the same as a relevant chunk.** Self-RAG grades the chunk; aptkit makes sure the model can't *cause* a bad retrieval in the first place by passing pathological arguments.

```
  Self-corrective RAG (canonical):     aptkit's version (argument guards):

  retrieve → ┌─ grade chunk:     ┐     model tool-call args
             │ relevant?grounded?│           │
             └────┬─────────┬─────┘           ▼
              ▼ yes      ▼ no            ┌─ minTopK floor: top_k = max(req, min)
          generate    rewrite/widen      └─ matchesFilter: ignore unknown keys
                                                │
                                                ▼
                                          pipeline.query (now safe)
```

### Move 2 — the two guards, and the failure each fixes

**Guard 1 — the `minTopK` floor. Fixes: a weak model passing `top_k: 1` and starving a multi-part question.**

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:51, 80-81
const minTopK = Math.max(1, options.minTopK ?? 1);
// ...in the handler:
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);   // ← floor: model can't go below
```

The comment on the option says it plainly (line 38-40): set `minTopK` above 1 to *"stop a weak local model from starving its own retrieval by passing top_k: 1 — the cause of multi-part-question misses."* A capable model picks a sensible `top_k`; a weak Gemma model sometimes asks for one chunk and then can't answer a two-part question because half the evidence never came back. The floor is the corrective step: it overrides the model's bad argument before it causes a miss. This is self-correction at the argument layer.

**Guard 2 — the hallucination-tolerant `matchesFilter`. Fixes: a weak model hallucinating a filter key that would silently wipe every result.**

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:101-106
function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  // A filter key only excludes hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
  // filter (e.g. {textContains: "x"}) can't silently wipe every result.
  return Object.entries(filter).every(([key, value]) => !(key in hit.meta) || hit.meta[key] === value);
}
```

Read the predicate carefully: a filter key only excludes a hit if the hit *has* that key with a *different* value. A key the chunk's meta doesn't have is ignored. So if the model invents `{textContains: "auth"}` — a key no chunk carries — every chunk passes instead of every chunk being wiped. The fail-open design is deliberate: a hallucinated filter degrades to "no filter," not "no results." Pair that with the over-fetch (`fetchK = topK * 4` when filtering, line 88) so a real filter can still return up to `topK` after post-filtering.

**Why this is corrective-RAG-in-spirit.** Canonical self-RAG asks "are these chunks relevant?" after the fact. aptkit asks "can this model's arguments break retrieval?" before the fact. Both refuse to let a bad retrieval flow unchecked into generation. aptkit's version is cheaper (no extra grading call) and tuned to its actual failure mode (a weak local model), which is the right call for a Gemma-default system — but it's *partial*: it doesn't catch a relevant-looking-but-wrong chunk the way a grader would.

### Move 2.5 — what aptkit doesn't have

No relevance grader. If `search_knowledge_base` returns five chunks that are topically close but don't actually answer the question, nothing catches it — the model grounds on them and may produce a confidently-wrong cited answer. The fix would be a grading step (a cheap model call: "do these chunks answer the query? yes/no") with a re-search fallback on "no." aptkit's forced synthesis turn and "say so plainly if the KB can't answer" prompt are the soft version; a hard grader is the upgrade.

### Move 3 — the principle

Retrieval success (a chunk came back) is not answer success (the chunk is relevant and the answer is grounded in it). The grader is the canonical gate that catches the gap. aptkit catches a *different* part of the gap — the model corrupting its own retrieval call — at the tool boundary, which is the right first guard for a weak-model system. The grader is the next layer when topical-but-wrong chunks become the dominant failure.

## Primary diagram

```
  aptkit's corrective guards — full frame

  model emits: search_knowledge_base(query, top_k?, filter?)
                              │
                              ▼
  ┌─ TOOL GUARDS (the correction) ──────────────────────────┐
  │  topK = max(requested, minTopK)        ← floor (:81)     │
  │  fetchK = filter ? topK*4 : topK        ← over-fetch (:88)│
  │  hits = pipeline.query(query, fetchK)                    │
  │  if filter: hits.filter(matchesFilter)  ← fail-open (:90)│
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ranked hits → model grounds + cites
  (NOT YET: a relevance grader between here and generation)
```

## Elaborate

Corrective RAG (CRAG) and Self-RAG formalized "don't trust the retriever blindly" — grade the chunks, and on low confidence rewrite or escalate. The production lesson is that the grader pays for itself when topical-but-irrelevant chunks are common. aptkit's design reflects a different production reality: its dominant retrieval failure isn't bad chunks, it's a *weak model passing bad arguments*. So it spent the guard budget there. Both are corrective RAG; they just correct different failures. When aptkit moves to a stronger model, the argument guards matter less and a relevance grader matters more.

## Interview defense

**Q: Do you guard against bad retrieval?**
Yes, at the tool boundary — two guards tuned to a weak local model. A `minTopK` floor so the model can't pass `top_k: 1` and starve a multi-part question, and a fail-open filter: a hallucinated filter key degrades to "no filter" instead of wiping every result. It's corrective RAG in spirit — I just correct the model's *arguments* rather than grade the *chunks*.

```
  minTopK floor (can't starve)  +  matchesFilter fail-open (can't self-wipe)
```
*Anchor: "retrieval success ≠ answer success" — I catch the model corrupting its own retrieval.*

**Q: What don't you catch?**
A topically-close-but-wrong chunk. I have no relevance grader, so if the store returns plausible-looking chunks that don't answer the question, the model grounds on them. The upgrade is a cheap grading call with a re-search fallback — I'd add it when the model gets strong enough that argument-corruption stops being the dominant failure.

## See also

- `01-agentic-rag.md` — the loop these guards harden
- `01-reasoning-patterns/03-react.md` — the targeted-hardening philosophy these guards exemplify
- `03-retrieval-routing.md` — the multi-source upgrade
- `study-ai-engineering/03-retrieval-and-rag/` — reranking and relevance scoring mechanics (cross-ref)
