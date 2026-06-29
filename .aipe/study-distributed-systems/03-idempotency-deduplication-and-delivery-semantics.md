# 03 — Idempotency, Deduplication, and Delivery Semantics

**Industry names:** idempotent operation · idempotency key · upsert · at-most-once / at-least-once / effective-exactly-once. **Type:** Industry standard.

## Zoom out, then zoom in

The repo has one genuinely idempotent operation and one that pretends to be safe to retry but isn't. Knowing which is which is the whole lesson.

```
  Zoom out — where retries land, and whether the target survives them

  ┌─ App ─────────────────────────────────────────────────────────┐
  │  FallbackProvider retry → model call    ← NOT idempotent       │
  │  runAgentLoop force-final-turn          ← NOT idempotent       │
  └────────────────────────────────┬───────────────────────────────┘
                                   │ writes
  ┌─ Storage (Postgres) ───────────▼───────────────────────────────┐
  │  ★ chunks upsert  on conflict (id) do update  ← IDEMPOTENT ★    │ ← we are here
  │  documents upsert on conflict (id) do update  ← IDEMPOTENT      │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: **idempotency** means *doing it twice has the same effect as doing it once.* It's the property that makes a retry *safe*. Once a call can be retried (and in a distributed system every call can — see `02`), you must ask of each target: "if this runs twice, what breaks?" An idempotent upsert: nothing breaks, the second write overwrites the first with identical data. A model call: it breaks your bill and possibly your output — two calls, two charges, two different generations.

## Structure pass — layers, one axis, the seams

**Layers:** the write targets, top to bottom: model call → trace insert → chunks upsert → documents upsert.

**The one axis: *what happens if this runs exactly twice?*** This is the idempotency x-ray:

```
  "run it twice — same result?"  — traced across the write targets

  ┌────────────────────────────────────────────────┐
  │ model call (Gemma/Anthropic)   twice = 2 charges, │  ✗ NOT idempotent
  │                                2 generations      │
  └────────────────────┬──────────────────────────────┘
       ┌───────────────▼──────────────────────────────┐
       │ trace INSERT into agents.messages   twice =   │  ✗ NOT idempotent
       │                       2 rows                  │     (append-only)
       └───────────────┬──────────────────────────────┘
             ┌─────────▼──────────────────────────────┐
             │ chunks upsert  on conflict (id)  twice =│  ✓ IDEMPOTENT
             │                same final row           │
             └─────────┬──────────────────────────────┘
                 ┌─────▼──────────────────────────────┐
                 │ documents upsert  on conflict (id)  │  ✓ IDEMPOTENT
                 └─────────────────────────────────────┘
```

The answer flips at the database boundary: the writes *to Postgres* are idempotent by construction; the writes *to the model and the trace log* are not. That split is the seam — and it tells you exactly which operations you can retry blindly (the upserts) and which need a dedup key first (everything above).

## How it works

### Move 1 — the mental model

You already know the shape from a React form with a primary key: if you `PUT /users/42` twice with the same body, the row ends up the same — the `id` makes the write idempotent. A `POST /users` *without* a client-supplied id is not: twice creates two rows. Idempotency is "is the identity of the result fixed by the input, or invented by the operation?"

```
  The idempotency kernel — identity decides the outcome of a repeat

  request carries id=K  ──►  WHERE id=K exists? ──no──► insert
                                  │
                                 yes ──► overwrite (same data → no-op effect)

  repeat with same id=K  ──►  always lands on the same row
  ───────────────────────────────────────────────────────────
  no id in the request   ──►  every call invents a new identity ──► duplicates
```

The kernel: **a deterministic key that the operation keys on.** Remove the key and the operation invents identity on each call — that's the non-idempotent case.

### Move 2 — walking the mechanism

**Part 1 — the idempotent upsert (the part the repo gets right).** Here's the chunk write in buffr:

```sql
-- packages/.../pg-vector-store.ts:47-56  (PgVectorStore.upsert)
insert into agents.chunks
  (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
on conflict (id) do update set            -- ← the idempotency mechanism
  document_id     = excluded.document_id,
  app_id          = excluded.app_id,
  chunk_index     = excluded.chunk_index,
  content         = excluded.content,
  embedding       = excluded.embedding,
  embedding_model = excluded.embedding_model,
  meta            = excluded.meta;
```

Read `on conflict (id) do update`: if a row with this `id` already exists, overwrite it instead of erroring. The `id` is deterministic — it's `"<docId>#<chunkIndex>"` (the `VectorChunk` shape from `packages/retrieval`). So re-indexing the same document produces the *same* chunk ids and the *same* embeddings, and the upsert converges to an identical final state no matter how many times it runs. That is what makes ingestion *safe to retry* — and it's why a crashed-and-restarted index job doesn't double the corpus. The `documents` write (`runtime.ts:11`) uses the same pattern: `on conflict (id) do update set content = excluded.content`.

```
  Re-running ingestion converges — that's idempotency earned by the key

  run 1:  doc "guide.md" → chunks "guide.md#0", "guide.md#1"  ──► 2 rows
  run 2:  same doc        → SAME ids                          ──► 0 new rows,
                                                                  same 2 rows updated in place
  run N:  ────────────────────────────────────────────────────► still 2 rows
```

**Part 2 — the non-idempotent retry (the part that bites).** Now contrast the model call. When the failover chain advances (`fallback-provider.ts:64`) or `runAgentLoop` forces a final turn after an error (`run-agent-loop.ts:216`), it issues a *fresh* `provider.complete(request)`. There's no idempotency key on the request — nothing says "if you already answered this exact request, return the prior answer." So a retry is a brand-new model call:

```
  Layers-and-hops — a retried model call is a new call, not a dedup hit

  ┌─ App ──────────────┐  attempt 1: POST /api/chat  ┌─ Ollama ───┐
  │ FallbackProvider    │ ──────────────────────────► │  generates │  ← charge/compute #1
  │  (p0 throws)        │                              └────────────┘
  │  advances to p1     │  attempt 2: POST (no key)   ┌─ Anthropic ┐
  │                     │ ──────────────────────────► │  generates │  ← charge/compute #2,
  └─────────────────────┘                             └────────────┘     DIFFERENT output
```

This is **at-most-once becoming maybe-twice.** If p0 actually *did* the work but the response was lost (a partial failure — see `02`), advancing to p1 does the work *again*. For a read-only question-answering call that's just wasted cost. For anything with a side effect it would be a double-action. The repo's agents are read-only (`toolPolicy` allowlists, per `context.md`), so the blast radius today is cost and output nondeterminism — not data corruption. But the *pattern* is non-idempotent, and that's the thing to recognize.

**Part 3 — delivery semantics, named on the repo's two paths.**

```
  Delivery semantics — what each path actually guarantees

  ┌──────────────────────┬───────────────────┬──────────────────────────────┐
  │ path                  │ semantics         │ why                          │
  ├──────────────────────┼───────────────────┼──────────────────────────────┤
  │ model call (chain)    │ at-MOST-once*     │ tried per-provider once; a   │
  │                       │  (*twice on retry)│ retry has no dedup key       │
  │ trace event → messages│ at-LEAST-once-ish │ append-only INSERT; a retry  │
  │                       │                   │ would duplicate rows         │
  │ chunk/doc ingest      │ effective         │ at-least-once delivery + an  │
  │                       │ EXACTLY-ONCE      │ idempotent upsert = converges │
  └──────────────────────┴───────────────────┴──────────────────────────────┘
```

The bottom row is the textbook trick: **you don't get exactly-once *delivery* — you get at-least-once delivery plus an idempotent *operation*, which is observationally exactly-once.** The chunk pipeline already has this property for free, because the key (`docId#index`) makes the delivery count irrelevant. That's the strongest idempotency story in the repo and worth naming explicitly.

**Part 4 — idempotency keys on model calls — `not yet exercised`.** The mechanism that would make a model-call retry safe is an **idempotency key**: hash the request, store `(key → response)` for a window, and on a retry with the same key return the cached response instead of re-calling. The repo has the *infrastructure* to do this (`@aptkit/memory`'s `recall` is keyed retrieval over the same vector store) but does not apply it to dedup model calls. Attach point: a key on `ModelRequest` plus a small cache the chain checks before `provider.complete`.

### Move 3 — the principle

Retries and idempotency are a pair — you can't have one safely without the other. The order of operations is always: (1) decide a call can be retried (it's remote, so it can), (2) check whether the target is idempotent, (3) if not, make it idempotent *before* you retry. The repo did this correctly for the database (the upsert key) and hasn't yet for the model call (no key). The general move: **push identity into the request so the operation keys on it, and "exactly once" falls out of "at least once" for free.**

## Primary diagram

Every write target with its idempotency verdict and delivery semantics.

```
  The idempotency map — retry-safe vs not

  ┌─ App process ──────────────────────────────────────────────────┐
  │  model call          ── retry = new call, no key   ✗  at-most*  │
  │  trace event         ── retry = new row            ✗  ≥once-ish  │
  └──────────────────────────────────┬──────────────────────────────┘
                                     │ to Postgres
  ┌─ Storage ──────────────────────── ▼─────────────────────────────┐
  │  chunks  on conflict (id=<doc#i>) ── retry = same row  ✓         │
  │  documents on conflict (id)       ── retry = same row  ✓         │
  │     └─ at-least-once delivery + idempotent op = EFFECTIVE        │
  │        exactly-once  (the corpus converges no matter the count)  │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

"Exactly-once" is the most misunderstood phrase in distributed systems. You cannot guarantee a message is *delivered* exactly once over an unreliable network — the sender can't tell "lost request" from "lost acknowledgment," so it must either risk losing the message (at-most-once) or risk duplicating it (at-least-once). What you *can* do is make the *effect* exactly-once by making the operation idempotent, which is what `on conflict (id)` buys here. This is why Kafka's "exactly-once semantics" is really "at-least-once delivery + idempotent producer + transactional consumer" — the same trick the chunk upsert uses, scaled up.

Idempotency keys are the generalization for operations that *aren't* naturally idempotent (charging a card, sending an email). Stripe's API is the canonical example: you pass an `Idempotency-Key` header and Stripe dedups for 24 hours. The repo's model calls are the equivalent un-keyed `POST` — fine while read-only, a bug the day a tool gains a side effect.

## Interview defense

**Q: "Is your ingestion pipeline safe to retry?"**
"Yes, and here's why specifically: the chunk write is `on conflict (id) do update` at `pg-vector-store.ts:47`, and the chunk id is deterministic — `docId#chunkIndex`. So re-running index on the same document produces identical ids and overwrites in place; the corpus converges regardless of how many times the job runs. That's effective exactly-once: at-least-once delivery plus an idempotent operation."

```
  re-index converges

  doc → chunks "d#0","d#1" → upsert (id) → same 2 rows every run
```

Anchor: *the deterministic key makes the upsert idempotent, so retry-safety is free.*

**Q: "Is your model fallback safe to retry?"**
"No — and I'd name it honestly. A retry is a fresh `provider.complete` with no idempotency key, so if the first provider actually did the work but lost the response, advancing re-does it: double cost, different output. It's tolerable today because the agents are read-only, but it's a non-idempotent retry. The fix is an idempotency key on `ModelRequest` with a short-lived response cache."

Anchor: *idempotent on the DB (keyed upsert), not on the model call (un-keyed retry).*

## See also

- `02-partial-failure-timeouts-and-retries.md` — retries are *why* idempotency matters
- `08-sagas-outbox-and-cross-boundary-workflows.md` — the dual write relies on both upserts being idempotent to be re-runnable
- `04-consistency-models-and-staleness.md` — read-your-writes after an idempotent upsert
- `study-database-systems` — how `on conflict` is implemented (the unique index, the conflict arbiter)
- `study-data-modeling` — the chunk id scheme and the soft `document_id` link
