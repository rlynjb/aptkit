# Recommender Systems

> recommender system · ranking / personalization

Blunt version: aptkit trains no model and ships no recommender. There's no user-item matrix, no ranker, no personalization layer in `packages/` or in buffr. This is new ground — study material plus a buildable exercise, not a tour of shipped code. `not yet exercised in aptkit` appears wherever you might otherwise assume something's running.

And there's a structural fact about your situation that changes the whole conversation: **buffr is a single-user personal agent.** That one constraint quietly deletes half of the recommender playbook before you even start, and knowing *why* is the most useful thing in this file.

## Zoom out, then zoom in

A recommender mostly lives at the Model and Deploy steps — it consumes features and produces a ranked list. But the interesting structure is in Features, where it decides *what* to compare: items, users, or both.

```
Generic supervised-ML pipeline · where a recommender sits
┌────────┐  ┌──────────┐  ┌────────────────────┐  ┌─────────┐  ┌────────┐
│  Data  │─▶│ Features │─▶│  Train / Val / Test │─▶│  Model  │─▶│ Deploy │
└────────┘  └────┬─────┘  └────────────────────┘  └────┬────┘  └────────┘
                 │                                      │
        ┌────────▼─────────┐                  ┌─────────▼──────────┐
        │ item features    │                  │ ★ RECOMMENDER      │
        │ user-item matrix │                  │  score & rank      │
        └──────────────────┘                  │  candidates        │
                                              └────────────────────┘
   what you compare ────────────▶ decides content vs collaborative
   what you output ─────────────▶ a ranked list, not a single label
```

The output isn't one prediction; it's an *ordering*. And the choice of what features feed it — properties of items, or the pattern of who-liked-what across many users — is the fork that splits the whole field into content-based, collaborative, and hybrid.

## Structure pass

Lay the three families along one axis: how much they lean on *other users*.

```
The recommender families · axis = reliance on a user population
NONE ◀──────────────────────────────────────────────────▶ TOTAL

┌─────────────────┐     ┌─────────────────┐     ┌──────────────────┐
│ CONTENT-BASED   │     │ HYBRID          │     │ COLLABORATIVE     │
│                 │     │                 │     │ FILTERING         │
│ "items like the │     │ blend both      │     │ "what users like  │
│  ones you liked"│     │ signals         │     │  YOU also liked"  │
│                 │     │                 │     │                   │
│ uses ITEM       │     │ uses BOTH       │     │ uses USER-ITEM    │
│ features only   │     │                 │     │ matrix            │
└────────┬────────┘     └────────┬────────┘     └─────────┬────────┘
         │                       │                        │
   works with         needs SOME population        needs MANY users
   ONE user ✔         (degrades w/ few)            (dead with one ✘)
```

The seam that matters for buffr is on the right edge. Collaborative filtering's entire mechanism is "find users similar to you, recommend what they liked." With exactly one user there is no neighbor population — the similarity computation has nobody to compare against. That family is simply off the table. So is the collaborative half of any hybrid. You're left with the left edge: content-based plus explicit rules.

## How it works

### Move 1 — the mental model

The mental model for the family you *can* use: **content-based recommendation is a similarity search in item-feature space.** You build a profile of what the user liked, represent each candidate item as a feature vector, and rank candidates by closeness to the profile.

```
Pattern · content-based = similarity in item space
 liked items ─▶ ┌──────────────┐
                │ user profile │  (centroid / weighted avg
                │  = avg of    │   of liked item vectors)
                │ liked vectors│
                └──────┬───────┘
                       │ cosine / dot
 candidate items ──────▶ score = similarity(candidate, profile) ─▶ rank ▼
```

No other users anywhere in that picture — which is exactly why it survives the single-user constraint. The user *is* the population.

### Move 2 — the steps

**Step A — featurize items.** Turn each buffr item into a vector. Tags, categories, recency, source, and an embedding of its text all concatenate into one feature vector per item.

```
Item → vector
item ─▶ [ tag onehot | category | recency | text embedding ] ─▶ v_item
```

```python
# not yet exercised in aptkit — buffr has no item-feature pipeline today
def featurize(item):
    return concat(onehot(item.tags), onehot(item.category),
                  recency(item.created_at), embed(item.text))
```

**Step B — build the user profile.** Aggregate the vectors of items the user engaged with into one profile vector. A weighted centroid (recent/strong signals weigh more) is the simplest honest choice.

```
Profile = weighted centroid of liked-item vectors
liked: v1 (w=1.0)  v2 (w=0.6)  v3 (w=0.3)
profile = (1.0·v1 + 0.6·v2 + 0.3·v3) / (1.0+0.6+0.3)
```

```python
# not yet exercised in aptkit
def profile(liked):
    vs = [featurize(i) * weight(i) for i in liked]
    return sum(vs) / sum(weight(i) for i in liked)
```

**Step C — score and rank candidates.** Score every candidate by similarity to the profile, sort descending.

```
Ranking
candidates ─▶ score_i = cosine(v_i, profile)
           ─▶ sort desc ─▶ top-K
```

```python
# not yet exercised in aptkit
ranked = sorted(candidates, key=lambda i: cosine(featurize(i), prof), reverse=True)
```

**Step D — apply a rules layer.** Pure similarity is monotonous (it keeps recommending near-duplicates). A thin deterministic rules layer on top enforces business logic the math won't: dedupe, recency floors, hard excludes, diversity caps.

```
Rules layer · deterministic, runs AFTER scoring
ranked list ─▶ [ drop already-seen ]
            ─▶ [ cap N per category  ]  (diversity)
            ─▶ [ pin / boost pinned  ]
            ─▶ final list ▼
```

```python
# not yet exercised in aptkit
def apply_rules(ranked, seen, max_per_cat=3):
    out, counts = [], {}
    for it in ranked:
        if it.id in seen: continue
        if counts.get(it.category, 0) >= max_per_cat: continue
        counts[it.category] = counts.get(it.category, 0) + 1
        out.append(it)
    return out
```

### Move 3 — the principle

The principle: **your data shape decides your algorithm, not your ambition.** One user means no collaborative signal exists to mine — and no amount of model sophistication conjures a neighbor population out of one person. Content-based + rules isn't a downgrade you settled for; it's the *correct* tool for the data you actually have.

## Primary diagram

```
Single-user content-based recommender · buffr shape
        buffr items the user engaged with
                     │
                     ▼
            ┌─────────────────┐
            │ featurize each  │  tags|category|recency|embedding
            └────────┬────────┘
                     ▼
            ┌─────────────────┐
            │ user profile    │  weighted centroid (the user IS the population)
            └────────┬────────┘
                     │ cosine
 candidate items ───▶ score & sort ──▶ ┌──────────────┐
                                       │ RULES LAYER  │ dedupe / diversity / pins
                                       └──────┬───────┘
                                              ▼
                                        ranked feed
   (no user-item matrix anywhere — collaborative filtering is impossible here)
```

Notice what's *absent*: there is no matrix of many users by many items, because there's only one user. That absence is the design, not a missing piece.

## Elaborate

- **The single-user wall is hard, not soft.** People assume "I'll just add collaborative later when I have more data." But buffr is *architecturally* one user — a self-hosted personal agent. More data means more *items* and more *history for that one user*, never more users. Collaborative filtering doesn't get unlocked; it stays impossible by design.
- **Cold start still bites.** Content-based dodges the user cold-start problem (you the user are known from item one) but a brand-new *item* with no engagement and a brand-new *profile* with no liked items both leave you with nothing to rank on. That's the item/user cold-start problem — see `11-cold-start.md`; your fallback there is rules and recency, not learned similarity.
- **Filter bubble is the content-based failure mode.** Pure similarity converges on more-of-the-same and starves serendipity. The diversity cap in the rules layer is the deliberate counterweight — it's not optional polish.
- **You don't need to train anything.** Content-based ranking with off-the-shelf embeddings plus cosine similarity is a *retrieval* problem, not a training problem. That fits aptkit's grain (it already leans on hosted models for embeddings) far better than standing up a training pipeline.
- **Implicit vs explicit signals.** With one user you have rich implicit signal (what they opened, kept, dismissed) and can ask for explicit signal (pins, thumbs). Weight explicit higher; it's scarcer and cleaner.

## Project exercises

### EX-ML-10a — Content-based ranker + rules layer over buffr items

- **Exercise ID:** EX-ML-10a (Phase 5 ML-hardening track — this is where buffr's feed stops being chronological and starts being ranked, the kind of personalization layer you harden once the basics ship).
- **What to build:** A content-based ranker that featurizes buffr items (tags + category + recency + an embedding of the text), builds a weighted user profile from engaged items, scores candidates by cosine similarity, and passes the result through a deterministic rules layer (dedupe seen, cap per category for diversity, honor pins). Embeddings come from aptkit's existing hosted-model path — no training.
- **Why it earns its place:** It's the *correct-by-construction* recommender for a single-user app and it makes the single-user constraint explicit in code, which is the exact insight an interviewer probes. It also reuses aptkit's retrieval/embedding muscle instead of inventing a training stack.
- **Files to touch:** Case B (new) — `packages/retrieval/src/rank/content-based.ts` (featurize, profile, cosine scorer), `packages/retrieval/src/rank/rules-layer.ts` (dedupe/diversity/pins), a new buffr persistence surface `buffr/src/feed/ranked-feed.ts` (wires engaged-item history → ranker → feed) plus its `buffr/src/feed/ranked-feed.test.ts`.
- **Done when:** Given a fixture of buffr items and a synthetic engagement history, the ranker returns items ordered by similarity to the profile, the rules layer demonstrably drops already-seen items and caps any single category, and a test asserts no collaborative-filtering code path exists (the function signature takes one user's history, never a user-item matrix).
- **Estimated effort:** 1–2 days

## Interview defense

**Q: Why not collaborative filtering — isn't it the gold standard?**

```
collaborative needs a CROWD          buffr has ONE user
 user-item matrix:                    matrix:
   u1 [• • _ •]                         u? [• • _ •]
   u2 [_ • • _]   find neighbors          (no other rows to compare)
   u3 [• _ • •]   ─▶ recommend           ─▶ no neighbors ─▶ no signal ✘
```

Collaborative filtering's mechanism is "users similar to you also liked X" — it requires a population to compute similarity over. buffr is a single-user personal agent, so the user-item matrix is one row; there are no neighbors and the signal doesn't exist. Anchor: same data-shape discipline as contrl, where the available signal (one person's pose stream) dictated the approach rather than the fanciest available algorithm.

**Q: Pure content-based keeps recommending the same thing. How do you fix it without collaborative data?**

```
similarity alone ─▶ near-duplicates ─▶ filter bubble ✘
similarity + rules layer:
   score ─▶ [cap per category] ─▶ [recency floor] ─▶ diverse feed ✔
```

The diversity comes from the deterministic rules layer, not the math — cap items per category, enforce recency, inject the occasional off-profile item. You buy serendipity with explicit rules because there's no crowd to borrow it from. Anchor: it's the same move as Platt-vs-isotonic in calibration — reach for the simplest deterministic correction before adding model machinery.

## See also

- [Transfer learning](./07-transfer-learning.md)
- [Confusion matrices](./08-confusion-matrices.md)
- [Calibration](./09-calibration.md)
- [Cold start](./11-cold-start.md)
