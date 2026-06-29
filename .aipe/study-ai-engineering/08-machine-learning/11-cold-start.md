# Cold start

**Subtitle:** the system that has no data yet · *Language-agnostic*

## Zoom out, then zoom in

Before any fix, here's where the problem lives. A recommender is a pipeline that
turns *who you are* plus *what you've done* into a ranked list. Cold start is the
single failure mode where the interaction box — the one that feeds everything —
is empty.

```
  Zoom out — the personalization pipeline (generic; aptkit has none)

  ┌─ Identity layer ───────────────────────────────────────────────┐
  │  user id · declared preferences · demographics                  │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ join
  ┌─ Interaction layer ───────▼─────────────────────────────────────┐
  │  ★ clicks · ratings · queries · history ★  ← cold start = EMPTY │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ build signal
  ┌─ Candidate layer ─────────▼─────────────────────────────────────┐
  │  item pool + item content features / embeddings                 │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ score + sort
  ┌─ Ranking layer ───────────▼─────────────────────────────────────┐
  │  ranked list → user; grade with precision@k (file 10)           │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. Every recommender that *learns* from behavior assumes the starred
box is full. Cold start is the day-one reality where it isn't — no clicks, no
ratings, no query history. The signal you'd normally lean on is absent, and a
collaborative model trained on "users like you also liked…" has no *you* and no
*like you* to work with. The fix is never "train harder"; it's "use a different
signal until the behavior signal exists."

## Structure pass

**Layers.** Identity → interaction → candidates → ranking. Collaborative methods
live or die on the interaction layer; content-based methods route *around* it by
scoring on the candidate layer's item features instead. Cold start is the rule
for which detour you take.

**Axis — which input is missing.** Trace what's empty and you get three distinct
problems, not one. The *user* row is new (no history for this person). The *item*
is new (no one has touched this thing). The *whole system* is new (the
interaction table itself is empty). Same headline, three different mitigations —
conflating them is the beginner error.

**Seam.** The load-bearing boundary is **the scoring function** — the code that
turns a request into a ranked list. A collaborative scorer reads the interaction
matrix; a content scorer reads item embeddings. Cold start forces you to ship a
scorer that does *not* depend on the empty box, then swap it once the box fills.
The seam is "what does `score(request) → ranked[]` read from?"

## How it works

### Move 1 — the mental model

A fresh buffr install is the cleanest cold start you'll ever see. buffr is
single-user; its corpus is `work.md`, `stack.md`, `coffee.md` — and on a
brand-new install that corpus is *empty*. `PgVectorStore.search(vector, k)`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts`) returns `Hit[]` of
`{id, score, meta}`, but with nothing indexed it returns `[]`. There is no
history to personalize from and nothing to retrieve. That is new-system *and*
new-user at once.

```
  Pattern — cold start is an empty box, not a broken model

  request ──► score(request) ──► ranked[]
                  │
                  ├─ reads interaction history ──► EMPTY ──► [] (collaborative fails)
                  │
                  └─ reads item content/embedding ──► still works ──► ranked[]
                            (content-based bridges the empty box)
```

You don't fix the empty box by waiting. You route the scorer through a signal
that exists on day one — item content — and let behavior accumulate behind it.

### Move 2 — the three cold starts, one box at a time

Each case is a *different empty cell* in the same table. The mitigation matches
the cell.

**New user — no interaction history.** The user exists but has done nothing.
Collaborative filtering has no neighbors to borrow from. Bridge with signals you
*can* collect at signup: declared preferences, onboarding answers, demographic
priors, and a global popularity fallback.

```
  New user — borrow from what they told you, not what they did

  ┌─ user (history = ∅) ─┐
  │ declared: ["typescript","postgres"]   ← onboarding question
  │ demographic prior: backend-leaning                            │
  └──────────┬───────────┘
             │ embed declared prefs → query vector
             ▼
  content-based recs ──► ranked[]
             │
             └─ if even declared prefs are empty ──► global popularity (prior)
```

```text
function recommendForNewUser(user, itemStore, popularity):
    if user.declaredPrefs is empty:
        return popularity.topK(k)          # global prior: safest default
    q = embed(user.declaredPrefs)          # content signal, not behavior
    return itemStore.search(q, k)          # nearest items by content
```

**New item — nobody has interacted with it.** The item exists but has zero
clicks, so collaborative methods never surface it (it has no co-occurrence with
anything). Bridge with the item's *own* content: embed its features and place it
near similar, already-known items. Content-based recs make a new item
recommendable the moment it's created, before a single interaction.

```
  New item — place it by content, near items that DO have history

  new item (clicks = 0)
   │ embed(item.contentFeatures)
   ▼
  item embedding ──► nearest known items ──► inherit their audience
   │
   └─ recommendable on day 0, no interactions required
```

```text
function placeNewItem(item, itemStore):
    v = embed(item.contentFeatures)        # title, tags, text — no behavior
    neighbors = itemStore.search(v, k)     # who is this item LIKE?
    # surface `item` to users who engaged with `neighbors`
    return neighbors
```

**New system — no data at all.** The interaction table itself is empty; there
is no model to serve. Bootstrap with rules and heuristics, editorial curation,
and a *pre-trained* embedding model for similarity. Serve content-based results
from day one, log every interaction, and retrain once enough has accumulated
(file 16).

```
  New system — bootstrap on a pre-trained embedding + rules, then collect

  day 0                              later
  ┌─ pre-trained embedding model ─┐  ┌─ enough logged interactions ─┐
  │ similarity over item content  │  │ retrain a real recommender   │
  │ + heuristic rules / editorial │  │ (file 16) — swap the scorer  │
  └──────────────┬────────────────┘  └──────────────▲───────────────┘
                 │ serve + LOG every interaction ────┘
                 ▼
            ranked[]  (grade with precision@k once you have labels)
```

```text
function bootstrapSystem(request, itemStore, rules):
    candidates = itemStore.search(embed(request), k)   # pre-trained embedding
    candidates = rules.apply(candidates)               # editorial / heuristics
    log(request, candidates)                            # collect for retrain
    return candidates
```

This is exactly the fresh-buffr story: empty corpus, single user, no history.
The mitigation is content-based similarity over a pre-trained embedding plus
heuristic rules, run until enough personal data accumulates — then you retrain
(file 16). You are never blocked; you are just on the bootstrap scorer.

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.
aptkit's "recommendation" is LLM-over-context — the model reads the retrieved
documents and reasons — not a fitted recommender, so it has no interaction matrix
to start cold against. The closest real artifact is buffr's empty-corpus install:
the same content-based-similarity bootstrap, with no learned model anywhere.

### Move 3 — the principle

Cold start is an *absence of one signal*, not a broken system. Name which input
is missing — user, item, or the whole table — and substitute a signal that
exists without behavior: content embeddings, declared preferences, global priors,
editorial rules. Serve the substitute, log everything, and let the behavior
signal earn its way in. The collaborative model is the destination, never the
day-one product.

## Primary diagram

```
  The three empty cells and their bridges

                 interaction history present?
                          NO              YES
              ┌───────────────────┬───────────────────┐
   new user?  │ NEW USER          │ (normal:          │
              │ → declared prefs  │  collaborative     │
              │   + popularity    │  filtering works)  │
              ├───────────────────┼───────────────────┤
   new item?  │ NEW ITEM          │ (item has         │
              │ → item content    │  co-occurrence)    │
              │   embedding       │                    │
              └───────────────────┴───────────────────┘
   whole table empty ──► NEW SYSTEM
     → pre-trained embedding + rules + editorial, LOG, retrain (file 16)

   every bridge routes AROUND the empty box via content, not behavior
```

## Elaborate

The hard-won lesson: content-based and collaborative methods are not rivals — one
is the cold-start scaffolding for the other. Content gets you to day-one
recommendations with zero behavior; collaborative takes over once behavior exists
and usually wins on relevance because it captures taste no content feature
encodes. Mature systems run both and blend by confidence. The trap is treating
cold start as a modeling problem (it isn't — there's no data to model) instead of
a *signal-substitution* problem. And the moment you have even a handful of labeled
queries, you measure: precision@k (`scorePrecisionAtK` /`scoreRecallAtK` in
`packages/evals/src/precision-at-k.ts`) grades the bootstrap scorer exactly as it
will grade the trained one — same metric, swapped model. Read `10-recommender-systems.md`
for the collaborative destination and `16-retraining-pipelines.md` for the swap.

## Project exercises

### Build the new-system bootstrap recommender on an empty buffr corpus
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a function that, given a fresh (empty-corpus) buffr install,
  embeds the request and returns `PgVectorStore.search(vector, k)` results,
  falling back to a hard-coded heuristic/editorial list when `search` returns
  `[]` because nothing is indexed yet.
- **Why it earns its place:** forces you to handle the empty box explicitly
  instead of crashing on `[]` — the literal new-system cold start.
- **Files to touch:** new `/Users/rein/Public/buffr/src/cold-start.ts`, reading
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** with an empty corpus the function returns the heuristic list,
  and after indexing `work.md` it returns real `Hit[]` from `search`.
- **Estimated effort:** `1–4hr`

### Grade the bootstrap scorer with precision@k once labels exist
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that runs the cold-start recommender against the
  labeled queries and scores it with `scorePrecisionAtK`, so the bootstrap
  scorer's day-one quality is measured before any retrain.
- **Why it earns its place:** proves the same metric grades the cold-start scorer
  and the eventual trained one — the bridge to file 16.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/score-cold-start.ts`,
  reading `/Users/rein/Public/buffr/eval/queries.json` and
  `packages/evals/src/precision-at-k.ts`.
- **Done when:** the script prints a precision@k number per query against
  `queries.json` using `scorePrecisionAtK`.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Your recommender has zero data on launch day. What do you ship?"**
Name which box is empty first — for a brand-new system it's the whole interaction
table, so collaborative filtering is impossible. Ship a content-based scorer over
a pre-trained embedding plus editorial/heuristic rules, serve from day one, and
log every interaction. Once enough behavior accumulates, retrain a real
recommender and swap the scorer. You're never blocked; you're on the bootstrap.

```
  empty table ─► content + rules (pre-trained embedding) ─► serve + LOG ─► retrain
                          day 0                                    later
```
*Anchor: cold start is signal substitution, not a modeling problem.*

**Q: "How do new users and new items differ — aren't they the same problem?"**
No — different empty cells, different bridges. A new *user* has no history, so you
borrow from what they declared (onboarding, demographics) and a popularity prior.
A new *item* has no interactions, so you embed its content and place it near
similar known items. One substitutes user signal, the other substitutes item
signal; conflating them ships the wrong fix.

```
  new user → declared prefs + popularity   (substitute USER signal)
  new item → content embedding → neighbors (substitute ITEM signal)
```
*Anchor: which input is missing decides the mitigation.*

## See also

- `10-recommender-systems.md` — the collaborative destination cold start bridges to
- `16-retraining-pipelines.md` — swapping the bootstrap scorer once data accumulates
- `01-supervised-pipeline.md` — the generic arc the eventual recommender follows
