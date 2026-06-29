# Self-Corrective RAG

**Industry term:** self-corrective RAG / CRAG (grade retrieved chunks before generating, fall back if weak). *Industry standard.*

## Zoom out, then zoom in

Add a relevance grader between retrieval and generation. Retrieval success (a chunk came back) is not answer success (the chunk is relevant and the answer is grounded in it). The grader is the gate that catches the gap. aptkit has *structural* versions of this guard, not a model-based grader — and the difference is the lesson.

```
  Zoom out — the gate would sit between the tool and the answer

  ┌─ Capability layer (rag-query) ──────────────────────────────┐
  │  model gets chunks ─► [grade?] ─► answer                     │ ← we are here
  └───────────────────────────────┬──────────────────────────────┘
                                   │
  ┌─ Tools layer ───────────────────▼───────────────────────────┐
  │  search_knowledge_base — has STRUCTURAL guards, no LLM grader │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit does not run a model-based relevance grader. What it has instead are structural guards in the retrieval tool (the `minTopK` floor and the tolerant filter) plus a model-side instruction to admit ignorance. The full CRAG loop — grade each chunk, fall back to query rewrite or wider search — is `not yet exercised`.

## The structure pass

**Layers.** Retrieval (returns chunks) → grading (relevant? grounded?) → generation or fallback.

**Axis: guarantees — is a returned chunk *trusted* to be relevant?** CRAG says no, and inserts a grader. aptkit says "partly" — it trusts the cosine ranking and adds structural floors, but no semantic grade.

**The seam.** The grader gate. In full CRAG, this is where a relevant/not-relevant decision routes to generate vs fall back. aptkit has no such gate; its closest equivalents are upstream (in the tool) and in the prompt.

## How it works

**Use case it would fit:** the `rag-query` agent, when retrieval returns plausible-but-off chunks and the model grounds a confident wrong answer in them. Today aptkit catches the *empty* case but not the *irrelevant* case.

### Move 1 — the mental model

It's input validation for retrieval. You don't trust user input just because it arrived; you don't trust a chunk just because cosine similarity ranked it. The grader is the validation step between "I got data" and "I'll act on it."

```
  retrieve → ┌─────────────────────────┐
             │ grade each chunk:        │
             │ relevant? grounded?      │
             └──────────┬───────────────┘
              ┌──────────┴──────────┐
              ▼ relevant            ▼ not relevant
          generate            fall back:
                              rewrite query / widen
                              search / escalate
```

### Move 2 — the walkthrough

**What aptkit has: structural guards, not a grader.** The retrieval tool clamps `top_k` to a floor and tolerates hallucinated filters (both walked in [01-agentic-rag.md](01-agentic-rag.md)). These keep retrieval from returning *too few* or *zero* chunks — but they don't judge whether the chunks that came back are *relevant*. A high-cosine but off-topic chunk passes straight through.

**What aptkit has: a prompt-side honesty instruction.** The rag-query system prompt ends with the fallback-by-admission rule:

```ts
// rag-query-agent.ts:20 — the only "grade" is the model admitting ignorance
'If the knowledge base does not contain the answer, say so plainly rather than guessing.'
```

That's a weak grader: it leans on the model to notice the chunks don't answer the question. For a strong model it half-works; for Gemma it's unreliable — a weak model will often ground an answer in irrelevant chunks rather than admit the gap. aptkit accepts that, because the alternative (an LLM grader call per chunk) costs tokens a weak model would spend unreliably anyway.

**What full CRAG would add.** A grade step after retrieval: score each chunk for relevance, and on low relevance route to a fallback — rewrite the query, widen the search, or escalate to a different source. In aptkit that's a new loop branch plus a grader (model or rule-based) between `search_knowledge_base` returning and the model generating. `not yet exercised`.

**The rule-based seam already exists in evals.** Worth noting: aptkit *does* have ranked-retrieval scorers — `scorePrecisionAtK` / `scoreRecallAtK` (`packages/evals`, `precision-at-k`). Those grade retrieval *offline* in eval, not *online* in the loop. The capability to measure relevance exists; it just isn't wired as an inline grader. That's the natural starting point if aptkit adopted CRAG.

### Move 2.5 — current state vs CRAG

```
  Phase A (now):  retrieve (with structural floors) → prompt says "admit if absent"
                  → generate.  No per-chunk relevance grade. Catches EMPTY, not IRRELEVANT.

  Phase B (CRAG): retrieve → grade each chunk (relevant? grounded?)
                  → relevant: generate / not: rewrite-query | widen | escalate
                  Reuses precision-at-k-style scoring, moved inline.
```

What wouldn't change: the tool, the pipeline, the contracts. CRAG adds a grade-and-route branch on the same retrieval seam.

### Move 3 — the principle

Retrieval success is not answer success. The grader is the gate that catches the gap between "a chunk came back" and "the answer is grounded in a relevant chunk." aptkit's structural floors catch the *empty* failure; the *irrelevant* failure is on the model's honesty, which is weak on a weak model. Naming that gap honestly — "we guard the empty case structurally, not the irrelevant case" — is the senior read.

## Primary diagram

```
  aptkit's partial self-correction vs full CRAG

  aptkit (now):  search (floors + tolerant filter) ─► chunks
                 ─► prompt: "say so if absent" ─► answer
                    (catches empty; trusts cosine for relevance)

  full CRAG:     search ─► grade each chunk ─┬─ relevant ─► generate
                                             └─ weak ─► rewrite | widen | escalate
                    (precision-at-k scorers exist offline; not wired inline)
```

## Elaborate

CRAG (Corrective RAG, Yan et al., 2024) added a lightweight retrieval evaluator that grades chunks and triggers a web-search fallback when retrieval is weak. The insight transfers regardless of implementation: never assume a retrieved chunk is relevant. aptkit's honest position is that it guards the cheap structural failures (empty, starved, hallucinated filter) and leaves the semantic-relevance grade to the model's self-honesty — a deliberate tradeoff given a weak local model where an LLM grader would be unreliable and expensive. The offline `precision-at-k` scorers are the seam where a real grader would plug in.

## Interview defense

**Q: Does aptkit grade retrieved chunks before generating?**

Not semantically. It has structural guards in the retrieval tool — a `minTopK` floor and a hallucination-tolerant filter — that catch the empty and starved cases. Relevance grading is left to a prompt instruction ("say so if the answer isn't there"), which is weak on a weak model. Full CRAG's grade-and-fall-back loop is not wired.

```
  caught structurally:  empty / starved / hallucinated-filter
  NOT caught:           high-cosine but irrelevant chunk → model may ground on it
```

I'd add that the building block exists — `scorePrecisionAtK` grades retrieval offline in evals; CRAG would move that inline.

*Anchor: retrieval success ≠ answer success; aptkit guards the empty case, not the irrelevant case.*

## See also

- [01-agentic-rag.md](01-agentic-rag.md) — the loop this grader would sit inside.
- [../04-agent-infrastructure/04-agent-evaluation.md](../04-agent-infrastructure/04-agent-evaluation.md) — the precision@k scorers used offline.
- RAG quality and groundedness mechanics: `.aipe/study-ai-engineering/03-retrieval-and-rag/`.
