# 08 — Sagas, Outbox, and Cross-Boundary Workflows

**Industry names:** saga · compensating transaction · transactional outbox · dual-write problem · reconciliation. **Type:** Industry standard.

## Zoom out, then zoom in

This is finding #2, and it's the most concrete distributed-systems bug in the repo. buffr's ingestion does a **dual write** — a `documents` row, then `chunks` in a *separate* transaction — and there is nothing tying them together. An embed failure between the two leaves a document with no chunks and no way to detect or repair it. It's a **saga with no compensation and no outbox.**

```
  Zoom out — a two-step workflow with no envelope around it

  ┌─ App (buffr) ───────────────────────────────────────────────────┐
  │  indexDocumentRow()                                              │
  │    step 1: INSERT documents   (pool, auto-commit)                │ ← we are here
  │    step 2: pipeline.index()  → PgVectorStore.upsert chunks       │   (the gap is
  │            (its OWN transaction)                                 │    BETWEEN them)
  └──────────────────────────────────┬───────────────────────────────┘
                                     │
  ┌─ Storage (Postgres) ───────────── ▼─────────────────────────────┐
  │  agents.documents  ◄┄┄ no FK ┄┄┄  agents.chunks                  │
  │  doc committed                    chunks may never arrive         │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: a **saga** is a multi-step workflow where each step is its own transaction, because the steps can't share one (different systems, or — here — different transaction scopes). The problem a saga must solve: if step 2 fails after step 1 committed, you have a *partial* workflow, and there's no automatic rollback because step 1 already committed. Sagas fix this with **compensation** (an undo for each step) or you avoid the split entirely with a **transactional outbox** (commit the intent atomically, do the side effect later). The repo has the dual write and neither fix — so the partial state just sits there.

## Structure pass — layers, one axis, the seams

**Layers:** the workflow (`indexDocumentRow`) → write 1 (documents, on the pool) → write 2 (chunks, in `PgVectorStore.upsert`'s own transaction).

**The one axis: *what is the atomic unit?*** Trace it:

```
  "what commits together as one unit?"  — traced down

  ┌──────────────────────────────────────────────┐
  │ indexDocumentRow()   atomic unit = NOTHING     │  ✗ no envelope over
  │  (no BEGIN/COMMIT around the two writes)       │    the two steps
  └────────────────────┬──────────────────────────┘
       ┌───────────────▼──────────────────────────┐
       │ INSERT documents (pool.query)  atomic =    │  ✓ atomic, but ALONE —
       │   just this one statement (auto-commit)    │    commits immediately
       └───────────────┬──────────────────────────┘
             ┌─────────▼──────────────────────────┐
             │ chunks upsert  atomic = all chunks   │  ✓ atomic (BEGIN/COMMIT
             │   (PgVectorStore wraps BEGIN/COMMIT) │    inside upsert)
             └─────────────────────────────────────┘
```

Each *step* is atomic; the *workflow* is not. The atomic unit shrinks as you go down — the workflow has none, each write has its own. That mismatch is the bug: the unit you reason about ("index this document") is not the unit that commits.

**The seam:** the gap *between* write 1 and write 2 (`runtime.ts:16` → `:17`). Atomicity flips across it — write 1 has committed and is durable; write 2 hasn't started. A crash or embed failure in that gap is the entire problem. The `chunks` table even *removes* the foreign key that would otherwise flag the orphan (`001_agents_schema.sql:27`), so the database won't complain.

## How it works

### Move 1 — the mental model

You know atomicity from a SQL transaction: `BEGIN; … COMMIT;` — all the writes land or none do. A saga is what you reach for when the steps *can't* be in one `BEGIN/COMMIT` — and then "all or none" is no longer free; you have to *build* it.

```
  The saga kernel — steps commit separately, so failure leaves a partial

  step 1 ──COMMIT──►  step 2 ──COMMIT──►  done ✓
     │                   │
     │                   └── FAILS here → step 1 is ALREADY committed
     │                                    → partial state, no auto-rollback
     │
     fix A (compensation): run undo(step 1) to repair
     fix B (outbox):       commit "intent to do step 2" WITH step 1, atomically,
                            then a worker does step 2 with retries
```

The kernel: **separately-committed steps + something that restores all-or-nothing.** Remove the "something" (compensation or outbox) and you have the repo's dual write: the steps commit separately and nothing restores the invariant.

### Move 2 — walking the mechanism

**Part 1 — the dual write, exactly as written.** Here's the whole function:

```typescript
// buffr/src/runtime.ts:5-18  (indexDocumentRow)
export async function indexDocumentRow(
  pool: pg.Pool, appId: string, pipeline: RetrievalPipeline,
  doc: { id: string; text: string; sourcePath?: string },
): Promise<void> {
  await pool.query(                                   // ← STEP 1: documents row
    `insert into agents.documents (id, app_id, source_type, source_path, content)
     values ($1, $2, 'markdown', $3, $4)
     on conflict (id) do update set content = excluded.content, source_path = excluded.source_path`,
    [doc.id, appId, doc.sourcePath ?? null, doc.text],
  );                                                  //   ← AUTO-COMMIT: doc is now durable
  await pipeline.index({ id: doc.id, text: doc.text }); // ← STEP 2: embed + upsert chunks
}                                                     //   in PgVectorStore's OWN transaction
```

Two `await`s, no transaction around them. Step 1 commits the document *immediately* (a bare `pool.query` auto-commits). Step 2 calls `pipeline.index`, which embeds the text (a network call to Ollama — see `02`, and it can hang or fail) and then upserts chunks inside its *own* `BEGIN/COMMIT` (`pg-vector-store.ts:42-58`). **Between the two `await`s, the document is durable and the chunks don't exist yet.**

**Part 2 — the failure that orphans the document.** Walk the crash:

```
  Execution trace — embed fails between the two commits

  state before:   documents = {}        chunks = {}
  step 1 commits: documents = {doc1}     chunks = {}        ← doc durable
  step 2 starts:  pipeline.index(doc1)
                    → embed(text) → POST Ollama → FAILS (daemon down, or hang→timeout)
                    → throws BEFORE chunks upsert
  state after:    documents = {doc1}     chunks = {}        ← ORPHAN
                  ─────────────────────────────────────────
  doc1 exists, is searchable as a document, but has ZERO chunks
  → retrieval returns nothing for it; nothing flags the inconsistency
```

The document is now a lie: it's in the system of record, but it's invisible to retrieval because it has no embedded chunks. Nothing detects this — there's no foreign key (chunks → documents is a *soft* link, FK explicitly dropped), no reconciliation job, no status column saying "indexed: false." It just sits there, silently broken.

**Part 3 — why there's no foreign key (and why that's a real tradeoff).** The schema deliberately drops the FK:

```sql
-- buffr/sql/001_agents_schema.sql:14-27
create table if not exists agents.chunks (
  id text primary key,
  -- Soft link to documents.id (no FK): the VectorStore contract upserts chunks
  -- with no notion of a documents row, so a hard FK would break drop-in parity.
  document_id text,
  …
);
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
```

This is a defensible call: the `VectorStore` contract (the load-bearing abstraction from `context.md`) upserts chunks knowing *nothing* about a `documents` row — that's what makes `InMemoryVectorStore` and `PgVectorStore` interchangeable. A hard FK would force every chunk write to have a parent document, breaking that parity. So the repo traded referential integrity for contract cleanliness — a real, deliberate tradeoff. The cost it accepted: the database can no longer flag an orphan, so the dual-write inconsistency is invisible at the storage layer.

**Part 4 — the two fixes, mapped to attach points.** Both are `not yet exercised`; here's where each would go.

*Fix A — compensation (make it a real saga).* Wrap the workflow so that if step 2 fails, you *undo* step 1:

```
  saga with compensation

  try:    INSERT documents       (step 1)
          pipeline.index(chunks)  (step 2)
  catch:  DELETE documents WHERE id = doc.id   ← compensating transaction
          (or mark indexed=false)
```

Attach point: a `try/catch` in `indexDocumentRow` with a delete-or-mark in the catch. Cheap, and it closes the orphan window for the common case.

*Fix B — transactional outbox (avoid the split).* Commit the document *and* an "index this" job in one transaction, then a worker drains the outbox with retries:

```
  transactional outbox

  ┌─ one transaction ──────────────────────────┐
  │ INSERT documents                            │
  │ INSERT outbox (task='index', doc_id, …)     │  ← intent committed atomically
  └─────────────────────────────────────────────┘
        later: worker reads outbox → pipeline.index → mark done (idempotent, retryable)
```

Attach point: an `agents.outbox` table plus a drain loop. This is the stronger fix — it survives a *crash* between the writes (the job is durable), not just an exception you can catch. It also leans on the idempotent upsert from `03`: the worker can retry safely because re-indexing converges.

*Fix C — reconciliation (the safety net).* Periodically scan for `documents` with zero `chunks` and re-index them. Attach point: a scheduled query `SELECT d.id FROM documents d LEFT JOIN chunks c … WHERE c.id IS NULL`. This catches whatever A and B miss — the backstop every saga system eventually grows.

### Move 2.5 — current state vs the fix

```
  Phase A (now)                          Phase B (any one fix)
  ─────────────────────────────────────  ────────────────────────────────────
  INSERT documents (auto-commit)          A: + catch → DELETE/mark on failure
  pipeline.index() (own txn)              B: + outbox row in step-1 txn, worker drains
  no envelope, no undo, no detection      C: + reconciliation scan for orphans
  embed failure → silent orphan           embed failure → repaired or never-committed
```

What *doesn't* change: the idempotent upsert (`03`) is already the convergence operation every fix relies on — the worker (B) or the retry (A) re-runs `pipeline.index` and the corpus converges. The repo's data model is already saga-friendly; it's only missing the envelope.

### Move 3 — the principle

The moment a workflow spans two transactions, "all or none" stops being free — the database gave it to you inside one transaction, and you have to *rebuild* it across two. The three tools are compensation (undo on failure), outbox (commit intent atomically, do the work later), and reconciliation (scan and repair). The dual-write problem is the canonical trap because the code *reads* atomic — two `await`s in a row look like one operation — but commits in two units. The skill is seeing the seam between the `await`s and asking "what's left half-done if I crash here?"

## Primary diagram

The dual write, the orphan window, and the three fixes in one frame.

```
  The dual-write saga — current gap and the three closures

  ┌─ indexDocumentRow (buffr/src/runtime.ts:5-18) ─────────────────┐
  │                                                                 │
  │  INSERT documents ──COMMIT──► [ORPHAN WINDOW] ──► pipeline.index │
  │  (pool, auto-commit)              ▲                (own txn)     │
  │                                   │                             │
  │                       crash / embed failure here                │
  │                       → doc durable, chunks absent, no FK to flag│
  └─────────────────────────────────────────────────────────────────┘
        │                          │                         │
   fix A: catch → undo/mark   fix B: outbox + worker    fix C: reconcile scan
   (closes exception window)  (closes crash window,     (backstop: find docs
                               durable + retryable)       with 0 chunks)
        └──────────── all three lean on the idempotent upsert (03) ───────┘
```

## Elaborate

The dual-write problem is one of the most common bugs in service-oriented systems: "write to the database, then publish an event" (or "write to DB A, then DB B") looks atomic in code and isn't. The transactional outbox is the standard fix in the microservices literature (it's how you reliably get a database change into a message broker) — commit the event *into the same database transaction* as the data, then a separate process relays it. The saga pattern (Garcia-Molina & Salem, 1987, originally for long-lived database transactions) is the compensation-based cousin: define an undo for each forward step.

The repo is a clean teaching case because the dual write is *small and visible* — two `await`s in a thirteen-line function. At scale this same shape hides across service boundaries and is far harder to spot. Learning to see the orphan window in `indexDocumentRow` is exactly the instinct that catches it in a 200-service architecture.

## Interview defense

**Q: "Walk me through a consistency bug in this codebase."**
"`indexDocumentRow` in buffr does a dual write — `INSERT documents` auto-commits, then `pipeline.index()` upserts chunks in its own transaction (`runtime.ts:16-17`). They're not atomic. If the embed fails in between — and it calls Ollama, which can hang or be down — the document is committed with zero chunks: an orphan. And `agents.chunks` has the FK to documents explicitly dropped (`001_agents_schema.sql:27`) for `VectorStore` contract parity, so the DB won't even flag it. It's a saga with no compensation."

```
  INSERT doc (commit) → [embed fails] → doc with no chunks, nothing detects it
```

Anchor: *two `await`s read atomic but commit in two units — that's the dual-write trap.*

**Q: "How would you fix it?"**
"Three options, escalating. Cheapest: `try/catch` in `indexDocumentRow`, and on failure delete-or-mark the document — closes the *exception* window. Stronger: a transactional outbox — write the document and an 'index' job in one transaction, a worker drains it with retries — closes the *crash* window too, because the intent is durable. And a reconciliation scan for documents with zero chunks as a backstop. All three lean on the upsert already being idempotent, so retrying `pipeline.index` converges. The data model's already saga-friendly; it just needs the envelope."

Anchor: *compensation closes the exception window, outbox closes the crash window, reconciliation is the backstop.*

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the idempotent upsert every fix relies on
- `02-partial-failure-timeouts-and-retries.md` — the embed call (Ollama) that fails in the orphan window
- `01-distributed-system-map.md` — seam 4 on the full map
- `09-distributed-systems-red-flags-audit.md` — this is finding #2
- `study-database-systems` — transactions, why the FK would normally guard this
- `study-data-modeling` — the soft `document_id` link and the contract-parity tradeoff
