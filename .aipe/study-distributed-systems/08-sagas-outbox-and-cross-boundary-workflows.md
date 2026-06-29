# 08 — Sagas, Outbox, and Cross-Boundary Workflows

**Industry names:** dual write · saga · compensating transaction · transactional outbox · reconciliation · best-effort side-effect — *Industry standard.*

## Zoom out, then zoom in

A saga is what you reach for when one logical operation spans *multiple systems* that
can't share a single transaction. The repo has one real instance: `indexDocumentRow`
writes a `documents` row to Postgres, then calls `pipeline.index()` which embeds via
Ollama and upserts chunks in a *separate* transaction. That's a **dual write** — two
commits, no shared atomicity — and it's the latent saga seam (finding #3). Full
sagas with compensation and a transactional outbox are `not yet exercised`; this file
shows the seam where they'd attach.

```
  Zoom out — the one multi-system workflow

  ┌─ buffr: indexDocumentRow(doc) ──────────────────────────────────────┐
  │  STEP 1: insert agents.documents row ──── commit #1 (Postgres)       │ ← write A
  │  STEP 2: pipeline.index(doc):                                        │
  │            embed(text) ──── Ollama HTTP (can fail/hang)              │ ← network call
  │            store.upsert(chunks) ──── commit #2 (Postgres txn)         │ ← write B
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │  ★ no transaction spans STEP 1 and STEP 2 ★
  ┌─ Postgres ───────────────────▼───────────────────────────────────────┐
  │  documents row committed; chunks may or may not follow                │ ← we are here
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: a single ACID transaction guarantees all-or-nothing — but only *within one
database*. The moment a workflow touches a second system (a second DB, an HTTP
service, a queue), you can't wrap them in one transaction, so you get a **partial
commit**: step 1 succeeds, step 2 fails, and now the systems disagree. A **saga** is
the pattern for that: break the workflow into steps, and for each step define a
**compensating action** that undoes it if a later step fails.

## Structure pass

**Layers.** The workflow (`indexDocumentRow`) → step 1 (Postgres write) → step 2
(Ollama embed + Postgres write).

**Axis — trace `atomicity` across the workflow's steps.**

```
  Axis — "is this all-or-nothing?" — within a step vs across steps

  ┌─ STEP 2's chunk upsert (PgVectorStore) ────┐
  │  begin / inserts / commit / rollback        │  → ATOMIC within itself ✓
  └──────────────────────┬──────────────────────┘   (file 03's transaction)
       ┌─────────────────▼────────────────────────┐
       │ STEP 1 + STEP 2 together                  │  → NOT atomic ✗
       └─────────────────┬────────────────────────┘   (two separate commits)
            ┌────────────▼──────────────────────────┐
            │ if STEP 2 fails after STEP 1 committed │  → orphan: doc with no chunks
            └─────────────────────────────────────────┘
```

**Seam.** Atomicity holds *inside* each step (the chunk upsert is a clean
transaction) but is *lost between* the steps — there's no transaction, saga, or
outbox spanning the documents-write and the chunks-write. That gap between steps is
where a partial commit lives, and it's the exact seam a saga or outbox would close.

## How it works

### Move 1 — the mental model: a saga is a transaction you have to undo by hand

A database transaction gives you `ROLLBACK` for free — fail anywhere, everything
reverts. Across systems you lose that, so a saga gives each step an *explicit undo*.
You know this shape from a multi-step form with a "back" button that has to clean up
what each step created: book the flight, book the hotel, charge the card — and if the
charge fails, *cancel the hotel and cancel the flight* (the compensations), because
the database can't roll them back for you.

```
  The saga kernel — forward steps, each with a compensation, undo in reverse

  forward:   step1 ──► step2 ──► step3 ✗ (fails here)
                                  │
  compensate: undo1 ◄── undo2 ◄───┘   (run compensations in REVERSE order)

  the kernel: every step that has a side effect needs a matching "undo this step"
              — because no ROLLBACK spans the systems
```

The load-bearing part: the *compensation*. Without it, a failed step 3 leaves steps 1
and 2 applied — an inconsistent state with no automatic cleanup. That's exactly
`indexDocumentRow`'s gap.

### Move 2 — walking the mechanism

**Step 1 — the dual write, exactly as written.** Here's the workflow. Two writes, no
transaction between them:

```ts
// buffr/src/runtime.ts (indexDocumentRow)
export async function indexDocumentRow(pool, appId, pipeline, doc): Promise<void> {
  await pool.query(
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, 'markdown', $3, $4)
     on conflict (id) do update set content = excluded.content, ...`,   // ← COMMIT #1
    [doc.id, appId, doc.sourcePath ?? null, doc.text],
  );
  await pipeline.index({ id: doc.id, text: doc.text });   // ← embed (Ollama) + COMMIT #2 (chunks)
}
```

The annotation that matters: the `documents` insert commits *immediately* (it's a
`pool.query`, auto-committed). Then `pipeline.index` runs — which calls Ollama to
embed (a network call that can hang or fail, per file 02) and *then* upserts chunks in
`PgVectorStore`'s own transaction. There is no `begin`/`commit` wrapping both. So if
the embed throws, you've already committed a `documents` row that has no chunks.

**Step 2 — the partial-commit failure, traced.** Walk what happens when step 2 fails:

```
  Layers-and-hops — partial commit when the embed fails

  ┌─ indexDocumentRow ─┐  hop 1: insert documents  ┌─ Postgres ─┐
  │                     │ ───────────────────────► │ documents  │ ← COMMITTED ✓
  │                     │ ◄──── ok ──────────────── │  row exists│
  │                     │                           └────────────┘
  │  pipeline.index():  │  hop 2: embed(text)       ┌─ Ollama ───┐
  │                     │ ───────────────────────► │  /api/embed│
  │                     │ ◄──── ERROR / hang ────── │  fails ✗   │ ← step 2 dies here
  │                     │                           └────────────┘
  │  throws ✗           │  hop 3: upsert chunks     ┌─ Postgres ─┐
  │  (never reached)    │      NEVER HAPPENS        │  chunks: 0 │ ← orphan: doc, no chunks
  └─────────────────────┘                           └────────────┘

  result: agents.documents has the row, agents.chunks has nothing → searchable doc
          that returns no chunks. No rollback undid the documents write.
```

The document row exists but is *unsearchable* (no chunks to match a query). There's no
compensation (no "delete the documents row if indexing failed") and no
reconciliation (no background job that finds docs-without-chunks and re-indexes
them). Today the blast radius is one local document and the caller sees the throw, so
it's an acceptable trade — but it *is* a partial commit across two systems, which is
the definition of the problem sagas solve.

**Step 3 — the best-effort side-effect: a deliberate non-saga.** Contrast the
`memory.remember` call (file 03/04), which is the *opposite* choice — explicitly
accept the partial outcome:

```ts
// buffr/src/session.ts:64-69
const answer = await agent.answer(question);
await trace.flush();
try {
  await memory.remember({ conversationId, question, answer });   // ← step that may fail
} catch {
  // swallow: memory is best-effort, the turn already succeeded   ← NO compensation, BY DESIGN
}
return answer;
```

This is a saga step with the compensation deliberately set to *nothing*: if remember
fails, don't undo the answer (the user already has it), don't retry, just drop it.
That's a valid choice for a best-effort side-effect — the cost of losing one memory is
low, the cost of failing the whole turn is high. Naming it as a *chosen* non-saga
(rather than an oversight) is the point: not every cross-boundary step needs
compensation; some side-effects are correctly fire-and-forget.

### Move 2.5 — current state vs the saga/outbox it would become

```
  Phase A: today (dual write, sync, local)   Phase B: if indexing went async
  ────────────────────────────────────────   ────────────────────────────────────
  insert documents (commit #1)                insert documents + outbox row
  embed + upsert chunks (commit #2)             IN ONE transaction (commit #1)
  fail in step 2 → orphan doc                 worker reads outbox → embed → upsert
  caller sees the throw                         chunks → mark outbox done
                                              fail → outbox row stays → RETRIED
  acceptable: 1 local doc, sync caller        reconciliation: orphans get fixed
```

The **transactional outbox** is the standard fix and it's elegant: instead of two
separate commits, write the documents row *and* an "index this doc" outbox row in
*one* transaction. A separate worker reads the outbox, does the embed+chunk-upsert,
and marks the outbox row done. If the worker dies mid-way, the outbox row is still
there, so it gets retried — at-least-once + idempotent upsert (file 03) =
effectively-once indexing. The documents-write and the intent-to-index become atomic,
which is exactly the guarantee the dual write lacks. It would attach the moment
indexing moved off the request path.

### Move 3 — the principle

A single transaction is the cheapest consistency you can buy — use it whenever the
whole operation lives in one database. The moment an operation spans two systems, that
free atomicity is gone and you face a choice: accept the partial commit (best-effort,
like `remember`), compensate it (a saga), or make the *intent* atomic and process it
reliably later (an outbox). The mistake is *not noticing you've crossed the boundary*
— writing two commits as if they were one transaction and being surprised by the
orphan. aptkit's dual write is fine at its scale, but the discipline is to *name* it
as a dual write so the day it scales, you reach for the outbox deliberately.

## Primary diagram

```
  Cross-boundary workflows in aptkit — one dual write, one best-effort step

  ┌─ indexDocumentRow (the dual write — finding #3) ────────────────────┐
  │  STEP 1: insert documents ─── commit #1 ──────────► Postgres ✓       │
  │  STEP 2: embed (Ollama) ──► upsert chunks ─ commit #2 ─► Postgres    │
  │          │                                                           │
  │          └─ if embed fails: STEP 1 already committed → ORPHAN doc    │
  │             no compensation, no reconciliation (acceptable @ 1 doc)  │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ session.ask → memory.remember (the deliberate non-saga) ───────────┐
  │  step that may fail, compensation = NONE (try/catch swallow)         │
  │  best-effort by design: losing a memory < failing the turn          │
  └─────────────────────────────────────────────────────────────────────┘

  NOT YET: transactional outbox (atomic intent + retrying worker),
           explicit compensating transactions, reconciliation jobs
```

## Elaborate

The dual-write problem is one of the most common ways real systems end up
inconsistent, precisely because it's invisible: each individual write looks correct,
and the bug only appears when step 2 fails after step 1 commits. The transactional
outbox became the standard answer because it sidesteps distributed transactions (2PC,
which is slow and has its own failure modes) entirely — you only ever commit to *one*
database per transaction, and the "second system" reads the outbox asynchronously.
It's the pattern behind reliable event publishing in most modern services.

Sagas (the term comes from a 1987 paper on long-lived database transactions) generalize
this to multi-step workflows where each step has a compensation. The key insight that
trips people up: compensations aren't perfect rollbacks — you can't un-send an email,
so the compensation is "send a correction." Sagas trade strict atomicity for
*eventual* consistency with explicit cleanup, which is usually the right trade when a
true distributed transaction is too expensive. aptkit's `remember` is a degenerate
saga (one step, empty compensation); `indexDocumentRow` is a two-step workflow that
*should* be a saga or outbox the day it leaves the request path.

## Interview defense

**Q: "Walk me through indexing a document — is it atomic?"**
"It's a dual write, and no, it's not atomic across the two steps — I'll name that
plainly. `indexDocumentRow` commits the `documents` row first, then `pipeline.index`
embeds via Ollama and upserts chunks in a *separate* transaction. If the embed fails
after the documents commit, I get an orphan — a document row with no chunks, so it's
searchable but returns nothing. Each step is atomic internally (the chunk upsert is a
proper `begin/commit/rollback`), but nothing spans them. At one-local-doc scale that's
acceptable and the caller sees the error. If indexing moved async, I'd use a
transactional outbox: write the documents row and an 'index me' outbox row in one
transaction, then a worker does the embed+upsert and retries on failure — atomic
intent plus at-least-once processing on an idempotent upsert."

```
  sketch

  insert documents (commit) ─► embed (FAIL) ─► chunks NEVER written = orphan
  fix: insert documents + outbox IN ONE TXN ─► worker drains outbox ─► retry-safe
```

**Q: "What's the difference between a saga and a transaction?"** — load-bearing:
"A transaction gives you `ROLLBACK` for free but only within one database. A saga is
for when the operation spans systems and you've lost that — so each step gets an
explicit *compensation* to undo it, run in reverse if a later step fails. The catch
people forget: compensations aren't true rollbacks — you can't un-charge a card
instantly, so the compensation is a *new* action (a refund). My `memory.remember` is a
one-step saga with an empty compensation by choice — best-effort, losing it is cheaper
than failing the turn."

*Anchor:* `indexDocumentRow` is a dual write (two commits, no atomicity); the outbox is
the fix; `remember`'s `catch {}` is a deliberate empty compensation.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — idempotent upsert makes outbox retries safe
- `02-partial-failure-timeouts-and-retries.md` — the embed failure that triggers the partial commit
- `04-consistency-models-and-staleness.md` — the orphan doc is an application-level inconsistency
- **study-database-systems** — single-DB transactions, the atomicity the dual write loses
```
