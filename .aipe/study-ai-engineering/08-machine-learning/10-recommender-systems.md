# Recommender systems

**Subtitle:** what-to-show-next · content vs collaborative vs hybrid · *Industry standard*

## Zoom out, then zoom in

A recommender is not a new kind of model — it is the supervised pipeline (file
01) pointed at one specific question: *given who you are and what you've
engaged with, which items go at the top of the list?* The starred box is the
ranking model; everything around it is the same data plumbing you already know.

```
  Zoom out — a recommender is a specialized supervised pipeline

  ┌─ Interaction layer ────────────────────────────────────────────┐
  │  who engaged with what (clicks, reads, likes) — or, single-user, │
  │  just one person's own corpus of items                          │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ feature engineering (file 02)
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  item embeddings + user signal → (user, item) feature vectors   │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit + select
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  ★ ranking model: score(user, item) → relevance ★              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ sort by score, take top-k
  ┌─ Serving layer ───────────▼─────────────────────────────────────┐
  │  ranked list of k items; grade with precision@k / recall@k      │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. The whole field splits on one question asked at the interaction
layer: *where does the signal for the recommendation come from?* It can come
from the items themselves (content-based), from other users (collaborative), or
both (hybrid). That single choice decides what data you need, and — the point
for this reader — it decides whether a single-user system like buffr can use the
technique at all.

## Structure pass

**Layers.** Interactions → features → ranking model → ranked list → eval. Same
five-layer shape as the supervised pipeline; the only specialization is that the
inference unit is a `(user, item)` pair and the output is a *sorted* list, not a
single label.

**Axis — what signal does the rec come from?** Trace the source of "you might
like this." Content-based: from the item's own features ("similar to things you
engaged with"). Collaborative: from other users ("people like you liked this").
Hybrid: from both. This axis is the entire taxonomy, and it is also a data
requirement — collaborative needs many users and an interaction log; content-
based needs neither.

**Seam.** The load-bearing boundary is the **item embedding function** — the
code that maps an item to a vector. Content-based recommendation *is* nearest-
neighbor search in that vector space. It is the exact same seam as your RAG
retrieval: `embed(item) → vector`, then sort by similarity. When that function
exists, you already have a content-based recommender.

## How it works

### Move 1 — the mental model

You already have a content-based recommender. buffr's `PgVectorStore.search`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts`) takes a query vector and `k`
and returns `Hit[]` of `{id, score, meta}` sorted by similarity. Swap the word
"query" for "an item the user engaged with" and that *is* content-based
recommendation: find items whose embeddings are nearest to the ones you liked.
No second user required.

```
  Pattern — content-based rec = the similarity search you already run

  an item the                      ┌──────────────┐   sorted neighbors
  user engaged with ──embed──► v ─►│ vector store │─► [{id, score}, …]
  (a note, a doc)                  │  search(v,k) │      = recommendations
                                   └──────────────┘
   no other users · no interaction log · just item ↔ item similarity
```

You don't need a ratings matrix to start. You need an embedding and a sort.

### Move 2 — the three families, one box at a time

**Content-based — recommend items like the ones you engaged with.** Build a
profile from the user's own items, then rank candidates by similarity to that
profile. Needs item features (or embeddings) and *nothing about other users*.

```
  Content-based: item features only

  user's engaged items        candidate item
  [▓ embeddings ▓] ──avg──► profile vector
                                 │  cosine
  candidate ──embed──► v ────────┴────► score, then sort
```

```python
# Content-based: rank candidates by similarity to the user's own profile.
def content_based(engaged_items, candidates, embed):
    profile = mean([embed(i) for i in engaged_items])   # user profile = avg of liked items
    scored = [(c, cosine(profile, embed(c))) for c in candidates]
    return sort_desc_by_score(scored)[:k]               # top-k by item↔item similarity
# needs: item embeddings. needs NOT: any other user.
```

**Collaborative filtering — recommend what similar *users* liked.** Build a
user×item matrix of interactions, find users (or items) with similar patterns,
and recommend the gaps. This is the family that needs *many users and history*.

```
  Collaborative: the user–item interaction matrix

            item1  item2  item3  item4  item5
  userA  [    5      ?      3      ?      1   ]
  userB  [    4      2      ?      ?      1   ]
  userC  [    ?      2      4      5      ?   ]   ← similar to userA on item3
  userD  [    1      5      ?      4      ?   ]
           ▲                  ▲
           known ratings      ? = the cells we predict (and recommend the high ones)

  userA and userC overlap on item3 → recommend userC's item4 to userA.
```

```python
# Collaborative (matrix factorization): learn latent user & item vectors,
# then predict the empty cells as their dot product.
def collaborative(matrix):                 # matrix[user][item] = rating or None
    U, V = factorize(matrix, rank=d)        # U: users×d, V: items×d (fit on KNOWN cells)
    def score(user, item):
        return dot(U[user], V[item])        # predicted rating for an UNSEEN cell
    return score
# needs: many users + an interaction LOG. with one user, every row but one is missing —
# there are no "similar users" to borrow from. CF is structurally impossible single-user.
```

**Hybrid — combine both.** Score with content-based *and* collaborative, then
blend (weighted sum, or one as a fallback for the other). Hybrids exist mostly
to cover collaborative's weakness on new items/users (cold-start, file 11).

```
  Hybrid: blend the two signals

  content score ─┐
                 ├─► w₁·content + w₂·collaborative ─► final rank
  collab  score ─┘   (collab handles popularity; content handles new items)
```

**Single-user case — content + rules, not collaborative.** A single-user agent
(buffr: one person's `work.md` / `stack.md` / `coffee.md`) has exactly one row
in the user–item matrix. There are no other users to be "similar" to, so
collaborative filtering has nothing to factor. The correct design is *content-
based + heuristic rules*: embedding similarity over the user's own corpus, plus
hand-written rules (recency, source weight, must-include tags).

```
  Single-user: content similarity + rules (the right design here)

  user's corpus ──embed+search──► candidate items by similarity
                                        │
                          apply rules ──┤  recency boost
                                        ├─ source weight (work.md > coffee.md)
                                        └─ hard filters (exclude stale)
                                        ▼
                                   ranked recommendations
```

```python
# Single-user recommender = content similarity + rules. No CF.
def single_user_recommend(query_item, store, rules):
    hits = store.search(embed(query_item), k=20)        # PgVectorStore.search → Hit[]
    scored = [(h, h.score * rules.weight(h.meta)        # rule-based reweighting
                       + rules.recency_boost(h.meta)) for h in hits]
    scored = [s for s in scored if rules.keep(s[0].meta)]  # hard filters
    return sort_desc(scored)[:k]
# this IS buffr's retrieval with a reweighting pass — already 90% built.
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study
ground. aptkit *does* ship a recommendation agent, but it is an LLM generating
recommendations from anomaly + diagnosis context — there is no interaction log,
no user×item matrix, and no fitted ranking model. It is LLM-over-context, not a
trained recommender. The honest closest real artifact is buffr's vector search,
which is a content-based recommender's retrieval half.

### Move 3 — the principle

Pick the family by the data you actually have, not the one you read about.
Collaborative filtering is the famous one, but it is a *multi-user* technique
that is structurally impossible with one user. For a single-user agent the right
answer is content-based + rules — which, for buffr, is the retrieval you already
run plus a reweighting pass. The trained learning-to-rank reranker (this
section's running example) is a content-based component, and you grade it with
precision@k / recall@k exactly as a multi-user system grades its ranked list.

## Primary diagram

The taxonomy as one decision, with the single-user verdict marked.

```
  Content vs collaborative vs hybrid — and the single-user verdict

                        what signal does the rec come from?
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
  ┌───────────┐               ┌───────────────┐             ┌────────────┐
  │ CONTENT   │               │ COLLABORATIVE │             │  HYBRID    │
  │ item      │               │ other users'  │             │ both,      │
  │ features  │               │ interactions  │             │ blended    │
  └─────┬─────┘               └───────┬───────┘             └─────┬──────┘
        │ needs: embeddings           │ needs: many users         │ needs: both
        │ needs NOT: other users      │ + interaction LOG         │
        ▼                             ▼                           ▼
   works single-user            ✗ impossible single-user     ✗ needs the CF half
        ★                       (one row, no neighbors)
        │
        └──► single-user (buffr) = CONTENT + RULES
             = PgVectorStore.search + a reweighting pass
```

## Elaborate

The hard-won lesson: collaborative filtering's power *is* its dependency — it
borrows signal from the crowd, so with no crowd it has nothing. New systems
discover this the painful way, by designing a ratings-matrix architecture for a
product that will only ever have one user's data. The general rule extends to
cold-start (file 11): even multi-user systems fall back to content-based for the
*first* interactions of any new user or item, because there is no collaborative
signal yet. So content-based is both the single-user answer and everyone's
cold-start floor — which is why it is worth building well. The bridge to this
repo is direct: a learned reranker over `PgVectorStore` hits is a content-based
ranking model, and it is scored by `scorePrecisionAtK` / `scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts`) — the same offline metrics that grade
any recommender's top-k.

## Project exercises

### Build a content-based "more like this" over the buffr corpus
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a function that takes one item id from the user's corpus,
  fetches its embedding, calls `PgVectorStore.search` with that vector, drops the
  item itself, and returns the top-k neighbors as recommendations.
- **Why it earns its place:** proves content-based recommendation is just
  item↔item similarity search — no other users, no matrix, no training.
- **Files to touch:** new `/Users/rein/Public/buffr/src/recommend-similar.ts`,
  reading `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** given a known item, the function returns k other items ordered
  by descending similarity, with the seed item excluded.
- **Estimated effort:** `1–4hr`

### Add a rules reweighting pass and grade it with precision@k
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a reweighting layer over the content-based recs above
  (recency boost + source weight + a hard staleness filter), then an eval that
  scores the reranked top-k against a hand-labeled relevant set using
  `scorePrecisionAtK` / `scoreRecallAtK`.
- **Why it earns its place:** this is the single-user "content + rules" design in
  full, graded by the exact offline metric real recommenders use — and it shows
  why collaborative filtering was never an option here.
- **Files to touch:** new `/Users/rein/Public/buffr/src/recommend-rules.ts` and
  `/Users/rein/Public/buffr/eval/recommend.test.ts`, importing
  `packages/evals/src/precision-at-k.ts`.
- **Done when:** the eval reports precision@k and recall@k for the reranked list,
  and reweighting changes the score versus the raw similarity order.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "Why can't a single-user agent use collaborative filtering?"**
Collaborative filtering predicts a user's missing cells by borrowing from
*similar users'* known cells. With one user the matrix has one row — every other
cell is empty and there are no neighbors to borrow from. The technique is
structurally undefined. The right design is content-based + rules: rank the
user's own items by embedding similarity, then reweight with heuristics.

```
  one-row matrix:  userA [ 5  ?  3  ?  1 ]   ← no other rows ⇒ no "similar users"
  fix: content-based — rank by item↔item similarity over THIS user's corpus
```
*Anchor: collaborative needs a crowd; single-user has none, so content + rules.*

**Q: "How does a learned reranker relate to recommenders, and how do you grade it?"**
A reranker scores `(query, candidate) → relevance` and sorts — that is a
content-based ranking model, the model box of a recommender pipeline. You grade
it offline exactly like any recommender's top-k: precision@k (of the k shown, how
many were relevant) and recall@k (of all relevant, how many made the top-k), via
`scorePrecisionAtK` / `scoreRecallAtK`.

```
  candidates ─► reranker score ─► sort ─► top-k ─► precision@k / recall@k
                                                   (packages/evals/src/precision-at-k.ts)
```
*Anchor: a reranker is a content-based ranking model, graded by precision@k/recall@k.*

## See also

- `01-supervised-pipeline.md` — the generic pipeline a recommender specializes
- `11-cold-start.md` — why even multi-user systems fall back to content-based
- `05-evals-and-observability/` — precision@k / recall@k as offline rec metrics
