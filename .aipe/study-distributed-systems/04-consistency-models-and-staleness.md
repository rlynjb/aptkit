# 04 — Consistency Models and Staleness

**Industry names:** read-your-writes · stale reads · eventual consistency · convergence · monotonic reads — *Industry standard.*

## Zoom out, then zoom in

Consistency is about *what a read sees* relative to *what was written.* The repo has
one real instance worth studying: episodic memory written at the *end* of a turn,
read at the *start* of future turns. That gap — write-then-later-read — is where
staleness lives.

```
  Zoom out — where staleness can appear

  ┌─ buffr ChatSession ─────────────────────────────────────────────────┐
  │  ask(q):                                                             │
  │    1. recall (search the store)  ──── READS the corpus + memory      │ ← reads here
  │    2. agent.answer()                                                  │
  │    3. memory.remember(turn)      ──── WRITES this turn into the store │ ← writes here
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ store.search / store.upsert
  ┌─ Vector store ───────────────▼───────────────────────────────────────┐
  │  ★ a read in step 1 of turn N+1 sees the write from step 3 of turn N  │
  │    ONLY if the write committed first — within one process it does ★    │ ← we are here
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: a **consistency model** is the contract for "if I write X then read, do I
see X?" The strongest is *read-your-writes* — you always see your own writes. The
weakest useful one is *eventual consistency* — you see them *eventually*, after some
convergence delay. aptkit is single-writer and single-store, so it gets the strong
guarantee almost for free — but the *best-effort memory write* and the *over-fetch-
then-filter recall* introduce two real staleness wrinkles.

## Structure pass

**Layers.** Read path (recall / search) → store → write path (remember / upsert).

**Axis — trace `does a read see the latest write?` across the turn boundary.**

```
  Axis — "read-your-writes?" — within a turn vs across turns vs across sessions

  ┌─ within one ask() call ───────────────────┐
  │  remember() is AWAITED before ask returns  │  → write committed, but...
  └──────────────────────┬──────────────────────┘
       ┌─────────────────▼────────────────────────┐
       │ across turns, same session                │  → next recall SEES it ✓
       │ (same pool, same store)                   │     (read-your-writes holds)
       └─────────────────┬────────────────────────┘
            ┌────────────▼──────────────────────────┐
            │ if remember() FAILED (caught/swallowed)│  → next recall MISSES it ✗
            └─────────────────────────────────────────┘     (silent staleness)
```

**Seam.** The consistency guarantee flips on whether `remember()` *succeeded*.
Because the failure is swallowed (`session.ts:64-69`), a dropped memory creates a
*permanent* stale gap — future recalls behave as if that turn never happened. That's
the only real consistency hazard in the repo, and it's a deliberate trade.

## How it works

### Move 1 — the mental model: a read is a snapshot of whatever committed before it

You already know this from a database read after a form submit: if the `INSERT`
committed, the next `SELECT` sees it; if the insert is still in flight, the select
might not. Memory recall is the same: it sees whatever `remember()` finished writing
before the recall's `search()` ran.

```
  Read-your-writes — the read sees writes that committed before it

  turn N:    ... answer ... ──► remember(turn N)  ──[commit]──┐
                                                              │
  turn N+1:  recall(q) ──► search() ─────────────────────────┴──► SEES turn N ✓
                            (because the upsert committed first)

  but if remember(turn N) threw and was swallowed:
  turn N+1:  recall(q) ──► search() ───────────────────────────► turn N MISSING ✗
                            (no error surfaced — silently stale)
```

### Move 2 — walking the mechanism

**Step 1 — the write is awaited, so within a session you get read-your-writes.**
buffr writes the turn into the same store the next recall reads:

```ts
// buffr/src/session.ts:60-70
async ask(question: string): Promise<string> {
  await persistMessage(pool, conversationId, 'user', question);
  const answer = await agent.answer(question);   // ← internally recalls from the store
  await trace.flush();
  try {
    await memory.remember({ conversationId, question, answer });  // ← AWAITED write
  } catch {
    // swallow: memory is best-effort, the turn already succeeded   ← the staleness source
  }
  return answer;
}
```

Because `remember` is `await`ed and the store is the same object held across turns,
turn N+1's recall *will* see turn N's exchange — *if the write succeeded*. That's
genuine read-your-writes within a session. The single store and single writer make
it nearly automatic.

**Step 2 — the staleness wrinkle: a swallowed write is permanently stale.** The
`catch {}` is the deliberate trade. The reasoning (in the comment) is sound: a
memory write failing must not cost the user the answer they already have. But the
consequence is honest staleness — if the Ollama embed call for `remember` fails (no
timeout, could even hang then get aborted), that turn never enters memory, and *no
future recall will ever see it.* There's no retry, no reconciliation, no dead-letter.
It's at-most-once memory, which means eventually-incomplete memory.

**Step 3 — recall over-fetches because the store has no metadata filter.** The
second wrinkle is about *reading the right rows*, not staleness per se. Memory and
documents share one collection (tagged by `meta.kind`), and the `VectorStore`
contract has no metadata predicate — so recall asks for *more* than it needs, then
filters client-side:

```
  // @aptkit/memory recall: over-fetch then filter by kind
  recall(query, k):
    hits = store.search(embed(query), k * SOME_FACTOR)   // ← over-fetch
    return hits.filter(h => h.meta.kind === 'memory').slice(0, k)  // ← client-side filter
```

Why this matters for consistency: if documents heavily outrank memory rows for a
query, the over-fetch window might not contain `k` memory rows even though they
exist — a *read* that misses present data. That's not staleness (the data is
current); it's an *incomplete read* caused by ranking + a missing server-side
filter. Same family of bug: the read doesn't reflect the full truth in the store.

### Move 2.5 — what's strong vs what's `not yet exercised`

```
  Comparison — consistency guarantees here vs the ones that don't apply

  guarantee                  status in this repo
  ─────────────────────────  ────────────────────────────────────────────
  read-your-writes           HOLDS within a session (single writer/store) ✓
                             BREAKS silently if remember() is swallowed   ⚠
  monotonic reads            trivially holds — one store, no replicas       ✓
  eventual consistency       N/A — there's nothing to converge (one copy)   —
  stale REPLICA reads        not yet exercised — no read replica            —
  cross-region convergence   not yet exercised — single region              —
```

The classic distributed staleness — "I read from a replica that lags the primary by
200ms" — *cannot happen here*, because there is one Postgres and one in-memory store.
Single-copy data is automatically consistent. Staleness only enters through the
*application-level* gap (swallowed write, incomplete read), not through replication
lag. That's the honest frame: aptkit's consistency hazards are in the app logic, not
the storage topology.

### Move 3 — the principle

Strong consistency is cheap when you have one copy of the data and one writer — you
get read-your-writes almost for free. It gets expensive the moment you add a second
copy (a replica, a cache, a second region), because now a read can hit a copy that
hasn't caught up. aptkit pays none of that cost because it has one copy. The lesson:
*don't add replicas for "scale" before you need them* — each one converts a free
strong guarantee into a staleness problem you now have to reason about. Know which
guarantee you're trading away before you add the copy.

## Primary diagram

```
  Consistency in aptkit — single writer, single store, two app-level wrinkles

  ┌─ buffr ChatSession (single writer) ─────────────────────────────────┐
  │  turn N:   answer ──► await remember(N) ──[commit OR swallow]──┐      │
  │  turn N+1: recall(q) ──► search() ────────────────────────────┘      │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
  ┌─ single vector store (no replicas) ──▼───────────────────────────────┐
  │  read-your-writes HOLDS ✓ (one copy, one writer)                     │
  │  wrinkle 1: swallowed remember() → that turn permanently stale ⚠      │
  │  wrinkle 2: over-fetch+filter → present memory rows can be missed ⚠   │
  └─────────────────────────────────────────────────────────────────────┘

  NOT present: replica lag, eventual consistency, cross-region convergence
```

## Elaborate

The consistency-model hierarchy (linearizable → sequential → causal → eventual) was
formalized to answer one question for *replicated* systems: when copies disagree,
what's the weakest contract that's still useful? aptkit sits *above* that entire
hierarchy because it isn't replicated — it's effectively linearizable by virtue of
having one copy. That's worth saying plainly in an interview: most "consistency"
questions assume replication, and the honest answer for this repo is "I don't have
that problem yet; my staleness is application-level, not replication-level."

The over-fetch-then-filter pattern is a *consistency-vs-capability* trade forced by
the contract: keeping `VectorStore` vendor-neutral (no metadata predicate) means the
filter moves to the client, which means reads can be incomplete under adversarial
ranking. The fix — a metadata filter in the contract, or a dedicated memory
collection — would attach the moment recall completeness matters more than contract
minimalism.

## Interview defense

**Q: "What's your consistency model?"**
"Single writer, single store, so read-your-writes holds for free — turn N+1's recall
sees turn N's memory because the write is awaited and the store is the same object.
There's no replication, so no replica-lag staleness, no eventual consistency to
reason about. My two real wrinkles are both application-level: a swallowed
`remember()` makes a turn permanently invisible to future recalls, and the over-
fetch-then-filter recall can miss present memory rows if documents outrank them.
Neither is a topology problem; both are logic I chose for good reasons."

```
  sketch

  ONE store, ONE writer → read-your-writes free ✓
  wrinkle: remember() catch{} → that turn silently stale forever ⚠
  wrinkle: search(k*f) then filter kind → present rows can fall outside the window ⚠
```

**Q: "When would staleness actually bite you?"** — the load-bearing answer:
"Two ways. One, if I add a read replica behind `PgVectorStore.search` for scale —
then a recall could hit a replica that hasn't applied the latest `remember`, and
read-your-writes breaks at the topology level. Two, today, if the embed call for
`remember` fails — it's swallowed, so that memory is gone with no retry. The second
is real now; the first is `not yet exercised` but it's the first thing replication
would cost me."

*Anchor:* read-your-writes holds because of one store + awaited write; the swallowed
`remember()` (`session.ts:67`) is the one real staleness source.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the at-most-once memory write
- `05-replication-partitioning-and-quorums.md` — where replica-lag staleness would enter
- `07-clocks-coordination-and-leadership.md` — ordering vs consistency
- **study-database-systems** — isolation levels, MVCC, snapshot reads inside Postgres
```
