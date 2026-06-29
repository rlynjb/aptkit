# 03 — Idempotency, Deduplication, and Delivery Semantics

**Industry names:** idempotency keys · upsert (insert-or-update) · at-most-once / at-least-once / effective-exactly-once · deduplication — *Industry standard.*

## Zoom out, then zoom in

Once you have retries (file 02), you have a new problem: a retry might re-apply a
write that already succeeded. The defense is **idempotency** — making an operation
safe to run twice — and the repo has exactly one strong instance of it: the
`upsert ... on conflict (id)` in `PgVectorStore`.

```
  Zoom out — where deduplication lives

  ┌─ App layer ─────────────────────────────────────────────────────────┐
  │  pipeline.index(doc) → chunks with DETERMINISTIC ids "<docId>#<n>"   │ ← key chosen here
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ store.upsert(chunks)
  ┌─ Storage adapter ────────────▼───────────────────────────────────────┐
  │  InMemoryVectorStore: Map.set(id, chunk)  — last write wins by key    │
  │  PgVectorStore: insert ... on conflict (id) do update  ← ★ idempotent │ ← we are here
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ TCP
  ┌─ Postgres ───────────────────▼───────────────────────────────────────┐
  │  agents.chunks — primary key (id) enforces the dedup                  │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: an operation is **idempotent** when running it N times leaves the system
in the same state as running it once. A keyed upsert is the cleanest idempotent
write there is: the *identity* of the row is the dedup mechanism, so a re-run
overwrites rather than duplicates. The trick is choosing the key so that "the same
logical thing" always lands on the same key.

## Structure pass

**Layers.** Key construction (app) → upsert (adapter) → primary-key constraint (DB).

**Axis — trace `delivery guarantee` across the writes in the repo.**

```
  Axis — "if this runs twice, what happens?" — across the three write paths

  ┌─ chunk upsert (PgVectorStore.upsert) ──────┐
  │  same id → overwrites                       │  → EFFECTIVELY EXACTLY-ONCE ✓
  └──────────────────────┬──────────────────────┘   (idempotent by primary key)
       ┌─────────────────▼────────────────────────┐
       │ trace insert (persistMessage)            │  → AT-LEAST-ONCE-ish, NO dedup ✗
       └─────────────────┬────────────────────────┘   (no key; a retry doubles the row)
            ┌────────────▼──────────────────────────┐
            │ memory.remember (best-effort)         │  → AT-MOST-ONCE (swallowed on fail) ✗
            └─────────────────────────────────────────┘   (a failure drops it silently)
```

**Seam.** The guarantee flips hard across these three writes: the chunk upsert is
idempotent, the trace insert is not (no unique key — re-running would duplicate
rows), and the memory write is at-most-once by design (the `catch {}` swallows
failures). Three different delivery semantics in one codebase — knowing which is
which is the lesson.

## How it works

### Move 1 — the mental model: the key IS the dedup

You already do this in React: a list `.map()` needs a stable `key` so React can
tell "this is the same item, updated" from "this is a new item." An idempotent
write is the same idea at the database: a stable row id so the database can tell
"this is the same chunk, re-embedded" from "this is a new chunk." Same primitive,
different layer.

```
  The idempotency kernel — stable key → upsert → one row no matter how many writes

  write #1: upsert(id="doc:42#0", vector=v1) ─┐
  write #2: upsert(id="doc:42#0", vector=v1) ─┤──► row "doc:42#0" exists ONCE
  write #3: upsert(id="doc:42#0", vector=v2) ─┘    (last write wins; never duplicated)

  the id is computed from (docId, chunkIndex) — same input → same key → same row
```

### Move 2 — walking the mechanism

**Step 1 — deterministic chunk ids.** The id isn't random; it's derived from the
document and the chunk's position, so re-indexing the same document produces the
*same* ids:

```
  // chunk id shape, from packages/retrieval (VectorChunk): "<docId>#<index>"
  index("doc:42", text) → chunks: ["doc:42#0", "doc:42#1", "doc:42#2", ...]
  re-index("doc:42", text)  → SAME ids → upsert overwrites, no duplicates
```

This is the load-bearing choice. A random UUID per chunk would make every re-index
*append* a fresh copy of the whole document — the corpus would grow without bound.
The deterministic id is what makes re-indexing idempotent.

**Step 2 — the in-memory store dedups by Map key.** The simplest possible upsert:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:18-23
async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);   // ← Map.set: same key overwrites. Idempotent for free.
  }
}
```

`Map.set` *is* an upsert — second write to the same key replaces the first. No
duplicates possible. This is idempotency falling out of the data structure.

**Step 3 — the durable store enforces it at the database.** `PgVectorStore` does
the same thing with SQL's `on conflict`:

```ts
// buffr/src/pg-vector-store.ts:47-56
await client.query(
  `insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, ...)
   values ($1, $2, $3, $4, $5, $6::vector, ...)
   on conflict (id) do update set            -- ← idempotency key = primary key (id)
     document_id = excluded.document_id, app_id = excluded.app_id,
     chunk_index = excluded.chunk_index, content = excluded.content,
     embedding = excluded.embedding, ...`,
  [c.id, docId, this.appId, chunkIndex, content, toVectorLiteral(c.vector), ...],
);
```

`on conflict (id) do update` is the database guaranteeing "one row per id" — the
primary key constraint is the dedup. Re-run the whole index ten times: the chunk
table is identical to running it once. This is *effectively exactly-once* for the
chunk write, achieved without any distributed coordination — just a stable key and
a uniqueness constraint. That combination is the cheapest exactly-once you can buy.

**Step 4 — where it's NOT idempotent: the trace.** `persistMessage` is a bare
`insert` with no unique key on the message content:

```ts
// buffr/src/supabase-trace-sink.ts:27-37 (paraphrased shape)
insert into agents.messages (conversation_id, role, content, ..., created_at)
values ($1, $2, $3, ..., coalesce($8::timestamptz, now()))
// ← no "on conflict" — re-running this INSERTS A SECOND ROW
```

There's no idempotency key here. If `flush()` were ever retried after a partial
failure, you'd get duplicate trace rows. Today that doesn't happen (flush runs once
per turn, and a failure throws out of `ask`), so the *delivery semantic* is "at most
once, and if the process survives, exactly once" — but it's not *guaranteed*
exactly-once, because nothing dedups a retry. Naming that honestly matters: the
chunk write is idempotent by construction; the trace write is not.

### Move 2.5 — the three delivery semantics, side by side

```
  Comparison — three writes, three guarantees, in this repo

  write              key / dedup            on retry          semantic
  ─────────────────  ────────────────────   ───────────────   ─────────────────────
  chunk upsert       primary key (id)        overwrites        effectively exactly-once ✓
  trace insert       none                    duplicates row    at-least-once (no dedup) ✗
  memory.remember    id memory:<cid>:<n>     overwrites...     at-most-once (swallowed) ⚠
                     (idempotent IF reached)  ...but a failure  on failure it's silently
                                              is caught & dropped  gone (best-effort)
```

The memory write is the subtle one. Its *id* (`memory:<convId>:<n>`) is
deterministic, so the *write itself* is idempotent like the chunk write. But
`session.ts:64-69` wraps it in `try { ... } catch {}` — a failure is swallowed so a
lost memory never costs the user the answer they already got. That's a deliberate
*at-most-once* choice for a best-effort side-effect. Idempotent-when-it-runs, but
not retried-until-it-succeeds.

### Move 3 — the principle

"Exactly-once delivery" across a network is impossible — the sender can never know
if a lost ack means "the write failed" or "the write succeeded and the ack was
lost." What you *can* build is **at-least-once delivery + idempotent processing =
effectively exactly-once.** Retry until you get an ack (at-least-once), and make the
operation safe to apply twice (idempotent), and the duplicates the retries cause are
harmless. aptkit gets the idempotent half right for chunks via the keyed upsert; it
just doesn't pair it with at-least-once retry on the trace, which is fine because
the trace is best-effort.

## Primary diagram

```
  Idempotency in aptkit — the key carries the guarantee

  ┌─ App: pipeline.index(doc) ────────────────────────────────────────┐
  │  deterministic id = "<docId>#<chunkIndex>"   ← same input → same key│
  └────────────────────────────────┬──────────────────────────────────┘
                                   │ upsert(chunks)
            ┌──────────────────────┴───────────────────────┐
            ▼                                               ▼
  ┌─ InMemoryVectorStore ─┐                  ┌─ PgVectorStore (buffr) ───────┐
  │  Map.set(id, chunk)   │                  │  insert ... on conflict (id)  │
  │  same key overwrites  │                  │  do update                    │
  │  → idempotent         │                  │  → idempotent (PK constraint) │
  └───────────────────────┘                  └───────────────┬───────────────┘
                                                             │ TCP
                                              ┌─ Postgres: agents.chunks ─────┐
                                              │  PRIMARY KEY (id) = the dedup  │
                                              └────────────────────────────────┘

  contrast: agents.messages (trace) has NO such key → retries would duplicate
```

## Elaborate

Idempotency keys in their full form — a client-generated UUID sent with a request so
the *server* can dedup retries (Stripe's `Idempotency-Key` header is the canonical
example) — are `not yet exercised` here, and they don't need to be: aptkit's
idempotency is *natural* (the chunk's identity is its key) rather than *synthetic*
(a key minted just for dedup). Synthetic keys matter when the operation has no
natural identity — "charge this card $10" has no inherent id, so you invent one.
"Store the embedding for chunk doc:42#0" already has an identity, so you reuse it.

This is the cheaper, better version when you can get it. The move would attach if
buffr ever exposed an HTTP endpoint that clients retried — then a synthetic
idempotency key on the request would dedup retries at the boundary, the way the
primary key dedups them at the storage layer today.

## Interview defense

**Q: "Is your indexing safe to retry?"**
"Yes, for the chunk writes — and it's safe for a specific reason. Chunk ids are
deterministic, `<docId>#<chunkIndex>`, and `PgVectorStore` does `insert ... on
conflict (id) do update`. So re-indexing the same document upserts the same rows
instead of appending duplicates — effectively exactly-once via a natural
idempotency key. The trace writes are *not* idempotent — `persistMessage` has no
unique key, so a retried flush would duplicate rows. That's acceptable because the
trace is best-effort and flush runs once, but I wouldn't retry it without adding a
dedup key first."

```
  sketch

  chunk:  upsert(id) on conflict do update   → retry-safe ✓ (PK is the key)
  trace:  insert (no key)                     → retry doubles rows ✗
  memory: deterministic id, but catch{}        → at-most-once by choice ⚠
```

**Q: "Why can't you just have exactly-once delivery?"** — the load-bearing answer:
"Because the sender can't distinguish a failed write from a successful write with a
lost acknowledgment. So you build it from two halves you *can* have: at-least-once
delivery (retry until acked) plus idempotent processing (safe to apply twice). The
duplicates the retries cause become harmless. My chunk upsert is the idempotent
half; the keyed primary constraint is what absorbs the duplicate."

*Anchor:* `on conflict (id) do update` (`pg-vector-store.ts:49`) is the natural
idempotency key; the trace insert has none.

## See also

- `02-partial-failure-timeouts-and-retries.md` — retries are why idempotency matters
- `08-sagas-outbox-and-cross-boundary-workflows.md` — idempotent steps make sagas safe to re-run
- **study-database-systems** — primary keys, unique constraints, `on conflict` internals
- **study-data-modeling** — the `agents.chunks` schema and its key design
```
