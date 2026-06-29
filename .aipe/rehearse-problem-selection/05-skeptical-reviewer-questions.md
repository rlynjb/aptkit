# Skeptical Reviewer Questions

*Brief-answer 10: the review-room questions that bite, and the answers that
hold under pressure. Coach posture — say this, not that.*

These are the questions a skeptical staff engineer asks in the room. The
weak answers concede the build was vanity; the strong answers hold the line
*without overclaiming*. Where the honest answer is "I don't know yet," it
says so and names the discovery question — that's a stronger answer than a
fabricated one.

```
  The questions, ordered by how hard they bite

  Q1  "One consumer. Why not just adopt LangChain?"        ← bites hardest
  Q2  "Isn't 'reusable across apps' speculation? n=1."
  Q3  "How do you KNOW the substrate works, not just RAG?"
  Q4  "Local Gemma has no tool-calling. Toy?"
  Q5  "No users, no auth, no scale. Is this real?"
  Q6  "What would have made you adopt instead of build?"
```

---

## Q1 — "You have one consumer. Why not just adopt LangChain and ship?"

This is the hardest question and the brief concedes it has teeth.

▸ **Don't say:** "aptkit is more scalable / more robust." (Marketing —
  collapses instantly; there's no scale to be robust at.)
▸ **Say:** "On pure delivery speed, adopt wins — I'd have shipped buffr
  faster. I built because the *goal* isn't shipping buffr fastest; it's a
  portfolio artifact for an AI-engineering pivot and keeping control of the
  stack. A framework gives me neither — 'I can wire LangChain' is a weaker
  signal than 'I built the retrieval loop, the agent loop, and the eval
  harness,' and a framework owns my control flow. If the goal were
  velocity, you'd be right."

```
  Which goal you optimize for flips the answer

  goal = ship buffr fastest  ───────────►  ADOPT wins (concede it)
  goal = pivot artifact +    ───────────►  BUILD wins (the actual goal)
         control + learning
```

┃ Anchor: name the goal first, then the answer follows. The mistake is
┃ defending build on velocity — it loses there, and you don't need it to win.

---

## Q2 — "Isn't 'reusable across apps' speculation? You have n=1 app."

▸ **Don't say:** "Lots of apps will use it." (Inventing a roadmap.)
▸ **Say:** "Correct — as an *app* count, it's n=1, and I won't claim a
  trend from one data point. But the reuse claim isn't resting on a second
  app. It's resting on a second *consumer of the contract*: `@aptkit/memory`
  reuses the exact `EmbeddingProvider`/`VectorStore` contracts with zero new
  infrastructure — `remember` is the index path, `recall` is the query
  path. The contract proved it was drawn at the right seam before any
  second app existed. The open question — does a genuinely different app #2
  consume the bundle unforked — is exactly why `>1 consumer` is a named
  non-goal, not a claim."

```
  Reuse evidence: not "n apps" — "n consumers of one contract"

  EmbeddingProvider / VectorStore  ◄── one contract
        │                    │
        ▼                    ▼
  retrieval (RAG)      memory (episodic)   ← 2nd consumer, zero new infra
        │
        ▼
  buffr's PgVectorStore  ← cross-repo consumer
```

---

## Q3 — "How do you know the *substrate* works, not just that RAG works?"

▸ **Say:** "Two of my three metrics — precision@k and rubric-judge — would
  pass even for a single-app library. They grade the RAG. The one that
  grades the *substrate* is the swap: `PgVectorStore implements VectorStore`
  in buffr (`pg-vector-store.ts:19`), wired at `session.ts:41`, swapping the
  in-memory store for Postgres/pgvector in one line across a repo boundary,
  off the published `@rlynjb/aptkit-core@0.4.1` bundle buffr pins. If that
  swap had needed a pipeline rewrite, the contract was cosmetic and the
  build failed. It didn't. That's the substrate scoreboard."

---

## Q4 — "Local Gemma has no native tool-calling. Isn't this a toy?"

▸ **Don't say:** "It works fine." (Hand-wave.)
▸ **Say:** "Gemma has no native tool-calling, so the provider *emulates*
  it with parse-retry (`packages/providers/gemma`). That's a deliberate
  scope choice, not a gap I'm hiding: native-tool models are a named
  non-goal because the point was to validate the neutral contract against
  the *hardest* provider — one with no tool-calling at all. If the contract
  holds for emulated tool-calling, a native-tool model is a strictly easier
  drop-in. Choosing the hard case first is the opposite of a toy."

---

## Q5 — "No users, no auth, no scale. Is this even a real project?"

▸ **Don't say:** "It could scale to many users later." (Inventing a future.)
▸ **Say:** "It's real *personal tooling plus a portfolio artifact* — and
  I'm not going to pretend it's anything else. There are no external users
  by design. Auth, multi-tenancy, and scale are named non-goals because
  buffr is single-operator and local-first; building them speculatively
  would trade time for capability no user is waiting on. The honest scope
  is one person, one consuming app — and I'd rather defend that than inflate
  it."

---

## Q6 — "What would have made you adopt instead of build?"

The question that proves the decision was reasoned, not reflexive.

▸ **Say:** "Three things would have flipped me to adopt: (1) a deadline —
  if buffr had to ship this week, velocity wins and I adopt. (2) A team —
  maintaining a published semver contract solo is a real ongoing cost; with
  one engineer and no reuse, that cost can outweigh the control. (3) If the
  portfolio goal were already met another way — then learning the internals
  stops being worth the build time. None of those held, so build won. If
  any had, I'd have run `npm install` and not looked back."

```
  The flip conditions — what would have made ADOPT correct

  deadline to ship      ──►  adopt (velocity wins)
  a team to maintain    ──►  adopt (contract upkeep cost)
  portfolio met already ──►  adopt (no learning premium)
  ─────────────────────      ─────
  none held              ──►  BUILD (the actual situation)
```

┃ The strongest signal in the room: naming the conditions under which you'd
┃ have made the *opposite* call. A decision you can't reverse-engineer is a
┃ decision you didn't really make.
