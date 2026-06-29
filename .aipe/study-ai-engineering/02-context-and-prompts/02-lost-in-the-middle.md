# Lost-in-the-middle

> Positional attention bias (Industry standard)

Models don't read a long context evenly. Attention concentrates at the *start* and the *end*; content buried in the *middle* gets the weakest treatment — the documented "lost-in-the-middle" effect. So stuffing 20 retrieved chunks into a prompt doesn't help linearly; the relevant chunk sitting at position 11 may as well not be there. aptkit's answer is exposure-reduction: keep retrieval small (default `topK=5`) and floor it with `minTopK` so you pass a few high-relevance docs rather than a wall of them. It does *not* reorder or rerank to exploit the start/end positions — that's the honest gap, and it cross-links to reranking.

## Zoom out, then zoom in

Picture attention as a U-curve over the prompt: high at the edges, sagging in the middle. The more documents you stuff in, the deeper and wider the sag — more content lands in the dead zone. aptkit shrinks the problem by shrinking the input: a small `topK` means fewer docs, so fewer of them fall into the middle in the first place.

```
Attention over a long context — the U-curve (LAYERS)

  attention
    high │█                                             █
         │██                                           ██
         │ ██                                         ██
         │  ███         ← lost-in-the-middle →       ███
    low  │    ████████████████░░░░░░░░░░░░░████████████
         └────────────────────────────────────────────────► position
          START                MIDDLE                  END
          (read well)        (under-attended)       (read well)

  aptkit's lever: keep topK small (default 5) so fewer docs land in the sag
  aptkit's GAP:   no reordering to push the best docs to START/END
```

The edges are prime real estate; the middle is the bargain bin. aptkit avoids overfilling the bin but doesn't yet move its best items to the prime spots.

## Structure pass

One axis: **how many documents reach the prompt, and in what order**.

- **How many (addressed)** — RAG retrieval defaults to `topK=5` (`packages/retrieval/src/pipeline.ts`, `queryKnowledgeBase` 50-59). The knowledge-base search tool also enforces a `minTopK` floor so a caller can't accidentally retrieve zero (`packages/retrieval/src/search-knowledge-base-tool.ts:51, 81`). Small and bounded — few high-relevance docs, not a wall.
- **What order (not addressed)** — whatever order the retriever returns, that's the order the model sees. There's no step that pushes the highest-relevance chunk to position 1 or the last position. No reranker, no middle-avoidance reorder. `not yet exercised`.

The seam: `topK` is the single knob that controls exposure. `Math.max(requestedTopK, minTopK)` (search-knowledge-base-tool.ts:81) clamps it from below; the default clamps it sensibly from the top.

## How it works

**Move 1 — the mental model.** If the middle of the prompt is a blind spot, the cheapest defense is to make the prompt short enough that there's barely a middle. Five well-ranked chunks have almost no dead zone. Twenty chunks have a big one — and your best chunk might be sitting right in it.

```
Why small topK reduces exposure (PATTERN)

  topK = 20:  [1][2][3][4][5][6][7][8][9][10][11][12]...[20]
              └edge┘└──────── big middle, mostly ignored ───────┘└edge┘
              relevant chunk at #11  →  likely lost

  topK = 5:   [1][2][3][4][5]
              └────── tiny middle ──────┘
              relevant chunk at #3  →  still near an edge, survives
```

**Move 2 — walk the pieces.**

**The default keeps retrieval small.** Five is the standard, not "as many as fit."

```
pipeline.ts queryKnowledgeBase (50-59)        the exposure lever
  query(text, topK = 5) ───────────────────  default 5, not "fill the window"
    → ranked chunks (top 5)                    few high-relevance docs
```

`packages/retrieval/src/pipeline.ts:50-59` defaults `topK` to 5. This is the whole exposure-reduction strategy in one number: fewer docs in, smaller middle, less lost.

**The floor stops topK from collapsing to nothing.** A caller passing a bad `top_k` can't silently retrieve zero relevant docs.

```
search-knowledge-base-tool.ts (51, 81)        the lower clamp
  minTopK = max(1, options.minTopK ?? 1)  ──  never below 1 (51)
  topK    = max(requestedTopK, minTopK)   ──  floor the request (81)
```

`packages/retrieval/src/search-knowledge-base-tool.ts:51` sets the floor; `:81` applies it as `Math.max(requestedTopK, minTopK)`. The two clamps together — default 5 from above, `minTopK` from below — keep retrieval in a narrow, useful band. That band is itself a lost-in-the-middle mitigation: a narrow band can't become a wall of docs.

**There is no reorder step — say it plainly.** The chunks reach the prompt in retrieval order; nothing repositions the strongest one to an edge.

```
the gap                                       what a fix would add
  retriever returns [c1, c2, c3, c4, c5]
  prompt sees       [c1, c2, c3, c4, c5]  ──  same order, no reranking
                          ▲
                    strongest chunk might sit here (middle) — and stay there
```

The mitigation is purely "fewer docs," not "best docs at the edges." Reranking and edge-placement are `not yet exercised` — cross-linked below.

**Move 3 — the principle.** Two independent levers fight lost-in-the-middle: *reduce the middle* (small `topK`) and *avoid the middle* (reorder best-to-edges). aptkit pulls the first lever well and leaves the second untouched. Pulling the first is the cheaper, higher-floor move — it helps regardless of ranking quality — which is why it's the right thing to ship first. But it's only half the standard defense.

## Primary diagram

```
aptkit's lost-in-the-middle scorecard

  REDUCE the middle (small topK=5)        ████████████  pipeline.ts:50-59
  FLOOR topK so it can't collapse         ████████████  search-...-tool.ts:51,81
  ─────────────────────────────────────────────────────
  REORDER best chunks to START/END        ░░░░░░░░░░░░  not yet exercised
  RERANK retrieved chunks                 ░░░░░░░░░░░░  not yet exercised  ← Case B
```

## Elaborate

Why "fewer docs" is the right first lever: it raises the floor without depending on ranking being perfect. Even a mediocre retriever benefits — with only 5 chunks, the dead zone is 1-2 positions deep, so even a misranked relevant chunk is never far from an edge. Reordering, by contrast, only helps if you *know* which chunk is best, which assumes good relevance scores. Cheap, robust, ship-it-first — then add reordering once you trust your scores.

The honest gap, stated for an interview: "We reduce exposure with a small `topK` and a `minTopK` floor, but we don't reorder or rerank — the strongest chunk can still land in the middle. The standard next step is to place the top-scored chunks at the start and end of the prompt and demote the rest toward the center." That's the move the Case B exercise builds.

## Project exercises

### Reorder retrieved chunks to put highest-relevance at the ends

- **Exercise ID:** `EX-CTX-02a`
- **What to build:** A reorder step in the retrieval-to-prompt path that places the top-scored chunks at the *start* and *end* of the assembled context and pushes lower-scored ones toward the middle (the "edge-loading" anti-lost-in-the-middle layout). This extends the Phase 1 (context) lost-in-the-middle mitigation from "fewer docs" to "best docs at the edges."
- **Why it earns its place:** It pulls the second, untouched lever — exploiting the U-curve instead of just shrinking it. It's the standard mitigation aptkit is missing, and it directly targets the documented attention bias.
- **Files to touch:** `packages/retrieval/src/search-knowledge-base-tool.ts` (after `pipeline.query`, ~88+); ordering applied before chunks become prompt text.
- **Done when:** for a ranked result `[c1..c5]`, the prompt order becomes edge-loaded (e.g. `c1, c3, c5, c4, c2`) with the two strongest at the ends, and the ordering is covered by a test.
- **Estimated effort:** `1–4hr`

### Add a relevance-aware rerank pass

- **Exercise ID:** `EX-CTX-02b`
- **What to build:** A rerank hook that re-scores the over-fetched candidates before truncating to `topK`, so the surviving 5 are the genuinely-best 5 (not just the retriever's first 5).
- **Why it earns its place:** Edge-loading only helps if the top chunks are actually the best — reranking earns that assumption. Together they form the full defense.
- **Files to touch:** `packages/retrieval/src/search-knowledge-base-tool.ts` (the over-fetch path, `fetchK`, ~88) and `pipeline.ts`.
- **Done when:** a candidate ranked #7 by the base retriever but most relevant ends up in the returned `topK`.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: How does aptkit fight lost-in-the-middle?**

```
  small topK (default 5) → tiny middle → fewer docs in the dead zone
  minTopK floor          → can't collapse to zero
```

Anchor: `pipeline.ts:50-59` (default 5), `search-knowledge-base-tool.ts:51,81` (floor). It reduces exposure.

**Q: Why small `topK` instead of reordering?**

Anchor: reducing docs raises the floor *regardless of ranking quality*; reordering only helps if relevance scores are trustworthy. Cheaper, more robust — the right first lever.

**Q: What's the gap?**

```
  retriever order == prompt order — no reorder, no rerank
  strongest chunk can still sit in the middle
```

Anchor: `search-knowledge-base-tool.ts` returns chunks in retrieval order; edge-loading/reranking `not yet exercised`.

## See also

- [01-context-window.md](01-context-window.md) — why you can't just stuff every chunk in.
- [03-prompt-chaining.md](03-prompt-chaining.md) — splitting work so each step's context stays focused.
- [../05-evals-and-observability/02-eval-methods.md](../05-evals-and-observability/02-eval-methods.md) — precision@k/recall@k measure whether the right chunks were retrieved at all.
