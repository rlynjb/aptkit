# Data-Modeling Audit — AptKit

Pass 1 of the audit-style shape: the seven data-modeling lenses, walked against the real repo. Each lens gets either a concrete finding (with `file:line` grounding) or an honest `not yet exercised`, plus the nearest in-repo analog so the relational concept still has a hook.

**The headline:** AptKit has no SQL/relational database, no ORM, no migration framework, no foreign keys. But `@aptkit/retrieval` now adds a real store-shaped model — a vector corpus of `(id, vector, meta)` rows with a similarity-search query path and a write-time dimension `CHECK` — and `@aptkit/memory` puts a *second kind of row* in that same store, partitioned only by a `meta.kind` tag. So the lens picture shifted again: the data model, integrity, normalization, and the query-pattern lenses all have store-shaped findings, and the memory partition is the repo's first genuine "two entities in one collection" problem. Transactions and relational migrations remain `not yet exercised`, taught as foundations the repo could adopt.

Ranked by what actually matters in this repo, worst-or-most-interesting first:

1. **The data model / shape** — exercised (type-shaped + file-shaped + **store-shaped**, now with TWO row kinds in one store: document chunks `"<docId>#<i>"` and memory turns `"memory:<convId>:<n>"`, told apart by `meta.kind`). The shared-store partition is the richest modeling case in the repo. → `06`, `07`.
2. **Indexing vs query patterns** — *partly exercised, and the most interesting modeling consequence lives here.* The retrieval package has a real query path (embed → cosine-rank → top-k); memory layers a `kind`-partition filter on top, and because the store has **no metadata index**, recall must over-fetch (`k*4`, min 20) then filter client-side. That over-fetch is a modeling consequence of an unindexed discriminator. Still a brute-force O(n) scan with no ANN index; the artifact side is still `not yet exercised`. → `06`, `07`.
3. **Integrity** — exercised and load-bearing. Two enforcement layers: evals (async, read-time, the artifact constraints) **and** the retrieval store's dimension check (the repo's *first* synchronous write-time `CHECK`, inherited by memory rows). → `06`.
4. **Normalization / duplication** — three real duplications: the recommendation-text-in-trace, `text` copied into chunk `meta` for citations, and `text` copied into memory-row `meta` for recall — all deliberate read denormalizations. → `06`, `07`, `02`.
5. **Access patterns / storage choice** — exercised at "flat files" + "in-memory `Map` corpus"; the corpus now holds two logical entities (documents + memory) in one store, partitioned by a tag. relational-vs-document is still moot. → `06`, `07`.
6. **Migrations / evolution** — barely exercised (`schemaVersion: 1`, never yet incremented).
7. **Transactions** — `not yet exercised` (no multi-write atomicity anywhere).

---

## Lens 1 — The data model and its shape

**Exercised, type-shaped and file-shaped.** AptKit's schema is not in DDL, it's in TypeScript types and in the JSON files those types serialize to.

The load-bearing schemas:

- **`WorkspaceDescriptor`** — `packages/context/src/workspace-descriptor.ts:18-28`. The domain entity model: one denormalized read-model carrying a project, its `events[]`, `customerProperties[]`, `catalogs[]`, and pre-aggregated `totalCustomers` / `totalEvents`. This is the closest thing to a relational schema in the repo. → full walk in `01-type-as-schema.md`.
- **`CapabilityEvent`** — `packages/runtime/src/events.ts:1-24`. A six-variant discriminated union; an append-only event-log schema. → `02-tagged-union-event-log.md`.
- **The replay artifact** — typed as `ReplayArtifact` / `QueryReplayArtifact` / `MonitoringReplayArtifact` / `DiagnosticReplayArtifact` in `apps/studio/src/types.ts:166-265`, persisted to `artifacts/replays/*.json`. The provider wire schema (`ModelRequest`/`ModelResponse`/`ModelMessage`/`ModelContentBlock`) lives in `packages/runtime/src/model-provider.ts:1-58`.
- **The vector corpus** — `VectorChunk { id, vector, meta }` / `VectorHit { id, score, meta }` in `packages/retrieval/src/contracts.ts:7-19`. The repo's store-shaped model: rows you `upsert` and `search`, not a type that serializes to a file. This is the closest thing to an actual database table in AptKit. → full walk in `06-vector-store-row-model.md`.
- **The memory row** — `MemoryTurn { conversationId, question, answer }` → a `VectorChunk` with id `"memory:<convId>:<n>"` and `meta = { kind:'memory', conversationId, text }` (`packages/memory/src/conversation-memory.ts:4-8, 80-87`); recalled as `MemoryHit { id, score, text, conversationId? }` (`:11-16`). A *second kind of row* in the SAME store as the document chunks, distinguished only by `meta.kind`. This is the repo's first multi-tenant collection — two logical entities, one physical store. → full walk in `07-memory-row-model.md`.

**Red-flag check — "everything in one JSON blob when the data has real structure":** *Not present.* The structure is real and modeled. The descriptor distinguishes events from catalogs from customer properties; the event union distinguishes six event types; the artifact distinguishes per-capability output (`recommendations` vs `anomalies` vs `diagnosis` vs `answer`). Nothing is dumped into an untyped bag.

## Lens 2 — Normalization and duplication

**Exercised, with one real (and deliberate) duplication.** The single source of truth principle is mostly honored, with one place it's violated for a reason.

The duplication: in a replay artifact, the agent's final output is stored **twice** — once as structured data (e.g. `recommendations[]` at `artifacts/replays/...sp-revenue-drop-w4-fixture-studio.json:14-79`) and again as a JSON string embedded inside the final `step` trace event's `content` field (same file, line 122). The recommendation text appears in both. Edit one, the other goes stale.

That's textbook denormalization — and it's the *right* call here. The structured array is what `packages/evals` validates and what `promote-replay-to-fixture.mjs` reads; the embedded string is what the Studio UI renders as the "raw model turn." They serve two different read paths, so storing the fact twice buys a faster read on each. It's a deliberate read optimization, not an accident — exactly the case the lens says is legitimate. → `02-tagged-union-event-log.md` and `01-type-as-schema.md` cover this.

A second, benign duplication: `capabilityId` repeats on every event in the `trace[]` array (`events.ts:1-24` — it's on all six variants). In a relational model that field would live once on the parent run row and be a foreign key, not be copied onto every child event. Here it's copied because each event is independently streamed over NDJSON and must be self-describing on the wire. → `02-tagged-union-event-log.md`.

A third duplication, in the retrieval corpus: the chunk's source `text` is copied into its `meta` at index time (`pipeline.ts:44`), so the same passage lives both in whatever produced it and in every chunk's metadata bag. This is deliberate — it's what lets the `search_knowledge_base` tool build a citation (`[docId] snippet…`) from a `VectorHit` alone, with no second lookup into a source-document store (there isn't one). Same legitimate-read-optimization shape as the recommendation duplication above. → `06-vector-store-row-model.md`.

A fourth duplication, the memory twin of the third: a remembered turn's formatted `text` is copied into the memory row's `meta` at `remember` time (`conversation-memory.ts:84`), so the exchange text lives both wherever the conversation was logged and in the row's metadata. Same reason — `recall` (and the `search_memory` tool) returns the turn text straight from the hit's `meta`, no second lookup. And one more wrinkle unique to memory: `conversationId` is encoded *twice* per row — once as the middle segment of the id `"memory:<convId>:<n>"` and once as `meta.conversationId` (`:82, 84`). The id-segment is for human readability and collision-safety; the meta field is what survives into a `MemoryHit` (the id isn't parsed back). Both are deliberate, neither is hand-edited. → `07-memory-row-model.md`.

**Red-flag check — "the same fact editable in two places":** *Present but contained.* The recommendation duplication is real; it's mitigated because the structured form is the source the tooling reads and the string form is generated from the same turn, never hand-edited.

→ The normalization *principle* (one fact, one home) is information-hiding for data. It's taught in `study-software-design`'s information-hiding concept; this audit applies it, it doesn't re-teach it.

## Lens 3 — Indexing vs query patterns

**Now partly exercised** — the retrieval corpus added a real query path, even though there's still no *index* in the B-tree/ANN sense.

**The artifact side is still `not yet exercised`.** Artifacts are read one of two ways: (a) load a whole JSON file with `JSON.parse` (`replay-runner.ts:82-83`), or (b) `readdir` a directory and sort filenames (`listReplayArtifacts`, `replay-runner.ts:31-44`). No `WHERE`, no `JOIN`, no index. The filename `.sort()` (`replay-runner.ts:43`) is a primitive ordered scan — the moral equivalent of a full table scan on a timestamp-prefixed key.

**The retrieval side IS a query path.** `queryKnowledgeBase` (`pipeline.ts:50-59`) runs embed → `store.search` → ranked top-k, and `InMemoryVectorStore.search` (`in-memory-vector-store.ts:25-33`) computes cosine similarity against *every* chunk, sorts descending, and slices `k`. The `search_knowledge_base` tool layers an exact-match metadata filter on top, over-fetching `topK * 4` so the post-filter still returns up to `topK` (`search-knowledge-base-tool.ts:87-90`). So there's a genuine ranked query with a predicate now — but the "index" is a brute-force linear scan, not an ANN structure (no HNSW, no IVF). It's O(n) over the corpus.

**Memory makes the same over-fetch-then-filter a *modeling consequence*, not just a tool detail.** This is the sharpest data-modeling lesson the corpus teaches. Memory rows and document rows share one store with no metadata index (the `VectorStore` contract is `upsert` + `search(vector, k)`, no `where` — `contracts.ts:33-37`). So `recall` *cannot* ask the store for "the nearest *memory* rows." It over-fetches `Math.max(k*4, 20)` rows of *any* kind, then filters `meta.kind === 'memory'` client-side and slices `k` (`conversation-memory.ts:94-98`). The over-fetch headroom is a *guess* — it is not a correctness guarantee. If memory is a heavily-outnumbered minority near the query, even 20 nearest can come back as <`k` after the filter, and recall under-delivers (or returns empty). That's the textbook cost of modeling a partition as an unindexed discriminator tag: the store can't select on it, so every read that needs one kind pays an over-fetch and a client-side scan. The fix when this graduates to `PgVectorStore`: push `WHERE meta->>'kind' = 'memory'` into the SQL and fetch exactly `k` — the over-fetch then vanishes. The over-fetch exists *only* because the in-memory contract has no `WHERE`. → `07`.

**Red-flag check — "frequent query with no supporting index":** *Present, but correctly so for an in-memory toy store.* The vector search has no ANN index — it scans the whole `Map` every query. That's the right call for the from-scratch in-memory adapter (a few thousand chunks max), and the explicit reason `PgVectorStore` is named as a drop-in behind the same contract (`in-memory-vector-store.ts:3-9`). **"N+1":** *Not present.* The closest thing — `evaluateReplayArtifactFiles` reading files in a loop (`replay-runner.ts:81-84`) — is a batch eval over a known small set, not a per-row fan-out on a hot path.

**Buildable target — three of them now.** For artifacts: if volume grows past a few hundred files, move them out of the filesystem into SQLite/Postgres and add an index on `(capabilityId, createdAt)`. For the corpus: when chunk count outgrows a linear scan, swap `InMemoryVectorStore` for a pgvector store with an HNSW/IVF index behind the same `VectorStore` contract — no pipeline change. For memory's partition: add an index/predicate on `meta.kind` so recall fetches exactly `k` memory rows instead of over-fetching and filtering — in pgvector that's a `WHERE meta->>'kind'='memory'` (optionally a partial index on it). Both are `study-system-design` storage decisions; the index *shapes* are the data-modeling follow-on. → `06`, `07`.

## Lens 4 — Transactions and integrity

**Integrity: exercised and load-bearing. Transactions: `not yet exercised`.** This split is the most important finding in the audit, so take the two halves separately.

**Integrity — yes.** Because the file layer has *no* write-time schema (JSON accepts anything), AptKit hand-rolls the constraint layer that a database would give for free. It lives in `packages/evals/src/assertions.ts` and `packages/evals/src/structural-diff.ts`. These functions are the repo's `NOT NULL` / type / `CHECK` constraints:

- `assertRequiredPaths` (`structural-diff.ts:49-51`) — the `NOT NULL` / required-column check.
- The per-field type checks in `assertReplayArtifactShape` (`assertions.ts:83-97`) — `schemaVersion !== 1`, `createdAt` must parse as a date, `durationMs >= 0`, `modelTurns >= 0`. These are `CHECK` constraints written by hand.
- `findSecretLikeString` (`assertions.ts:397-421`) — a constraint with no SQL analog at all: "no row may contain an API-key-shaped string." A data-exposure guard baked into the integrity layer.

→ full walk in `05-structural-diff-integrity.md`.

**The one synchronous, write-time `CHECK` — the retrieval dimension guard.** This is the exception to "all integrity is async read-time evals," and it's the most database-like constraint in the repo. `InMemoryVectorStore.assertDimension` (`in-memory-vector-store.ts:36-42`) rejects any vector whose length doesn't match the store's dimension — on `upsert` *and* on `search`, with a throw, before any row lands. `assertWiring` (`pipeline.ts:22-29`) enforces the same invariant one level up, at pipeline-construction time, so you can't even wire a 64-dim embedder to a 768-dim store. Why a throw and not a warning: a dimension mismatch silently corrupts ranking (cosine over the overlapping prefix returns a plausible-looking but wrong score), so it's the one invariant that *cannot* be caught after the fact by evals. It's a real `CHECK (length(vector) = 768)` that fires synchronously. → `06-vector-store-row-model.md`.

**Transactions — no.** There is no atomic multi-write anywhere. The one place it would matter is fixture promotion (`promote-replay-to-fixture.mjs`): it reads an artifact, reads the source fixture, then `writeFile`s a new promoted fixture (`:33`, `:40`, `:79`). If the process dies between reads and the write, nothing is corrupted (the write is the only mutation, and it's a single new file), so the lack of a transaction is safe *by construction* — every operation in the repo is single-file-write or read-only. There is no operation where two writes must succeed together.

**Red-flag check — "multi-write operation with no transaction" / "invariant enforced only in hopeful app code":** The first is *not present* (no multi-writes exist). The second is **mostly the defining characteristic of the repo, with one exception** — almost every invariant is enforced in app code (`packages/evals`), asynchronously, because there's no DB. The honest framing: the evals layer is *good* hopeful-app-code — versioned, tested, run in CI — but it only fires when you run it; a hand-edited fixture that's never re-evaluated can violate every invariant silently. The exception is the retrieval dimension check (above), which enforces its one invariant the way a database does — synchronously, at write time, no opt-out. So the repo went from "zero synchronous constraints" to "exactly one" with `@aptkit/retrieval`.

## Lens 5 — Migrations and evolution

**Barely exercised.** The entire migration story is one field: `schemaVersion: 1`, set at write time (e.g. `apps/studio/src/replay-artifacts.ts:25`, `scripts/replay-model-recommendation.mjs:68`) and asserted at read time (`assertions.ts:83-85`, `apps/studio/vite.config.ts:1503` throws if `!== 1`).

It has never been incremented. There is no migration script, no backfill, no handler for "what if I see a `schemaVersion: 0` file." The version is a *seam reserved for a migration*, not a migration that's happened. → `03-versioned-artifact-schema.md` walks what's there and what a v1→v2 migration would actually require.

**Red-flag check — "destructive migration with no rollback" / "column drop with no backfill":** *Not applicable yet* — no migration has ever run. The latent risk: the read-side check is `!== 1` (hard fail), so the day the artifact shape changes, every old artifact on disk becomes unreadable in one step unless a migration is written first. That's the migration discipline `03` teaches before it's needed.

**Adjacent evolution that IS exercised:** fixture promotion (`04-fixture-promotion-lifecycle.md`) is a *data lifecycle* — live run → artifact → promoted fixture, with timestamps and provenance (`promotion.sourceArtifact`, `promotion.promotedAt` in the promoted JSON). That's versioning of recorded data, even though it's not schema migration.

## Lens 6 — Access patterns and storage choice

**Exercised at the "flat files on disk" level; relational-vs-document is moot.** AptKit's storage is the filesystem. Two access shapes:

- **Whole-object read** — fixtures and the `WorkspaceDescriptor` are always read entire, parsed, and used whole (`schemaSummary` consumes the full descriptor, `workspace-summary.ts:11-52`). Nothing reads a sub-field in isolation. This is a document-shaped access pattern, and the denormalized `WorkspaceDescriptor` shape matches it exactly.
- **Append + list** — artifacts are written once, never updated, and listed by filename (`replay-runner.ts:31-44`). Append-only, immutable. This matches the event-log model perfectly.
- **Upsert + ranked search** — the retrieval corpus is held in an in-memory `Map<id, VectorChunk>` (`in-memory-vector-store.ts:11`) and queried by cosine similarity. Keyed-write + similarity-read. This is a genuinely different access shape from the other two, and the in-memory `Map` is the deliberate "build the whole pipeline with zero cloud" storage choice (`in-memory-vector-store.ts:3-9`), with `PgVectorStore` named as the production drop-in behind the same contract. → `06`.
- **Upsert + ranked search + partition filter** — memory adds a *fourth* shape on top of the third: the SAME store now holds two logical entities (documents + conversation turns), and the read path must select one. Because the store can't filter, the access shape is "over-fetch a mixed bag, partition client-side by `meta.kind`, slice `k`" (`conversation-memory.ts:94-98`). The module supports two storage choices with zero code change (`conversation-memory.ts:20-26`): memory *shares* the document store (the tag does the partitioning) or gets a *dedicated* store (the tag is a no-op, the filter always passes). Shared = one piece of infra, but over-fetch can under-deliver in a large corpus; dedicated = isolation + an explicit `search_memory` tool, no over-fetch risk. The "which store?" call is `study-system-design`; the `kind`-as-partition *shape* is data modeling. → `07`.

The storage *choices* (flat JSON files for artifacts/fixtures; an in-memory `Map` for the corpus) are the right ones for a library + preview tool: zero infra, git-diffable fixtures, inspectable artifacts, and a corpus you can index and query in a unit test with no Ollama and no Postgres. The shapes (denormalized documents, append-only log, keyed vector rows) match their access patterns. There's no relational schema fighting a document access pattern, because there's no relational schema at all.

**Red-flag check — "relational schema fighting a document access pattern, or vice versa":** *Not present.* Document-shaped storage, document-shaped access. Consistent.

**The seam to system-design:** *when* to graduate from flat files to SQLite/Postgres is a `study-system-design` question (it's about infra and scale). The data *shape* once you do — keep `WorkspaceDescriptor` as a JSON column? split events into a child table? — is the data-modeling follow-on, and the answer flows from the access pattern: since the descriptor is always read whole, a JSONB column beats a normalized split.

## Lens 7 — Data-modeling red-flags audit (capstone)

The consolidated checklist, marked against AptKit:

```
  red flag                                          AptKit
  ────────────────────────────────────────────────  ──────────────────────────
  no discernible model (one untyped blob)            CLEAR — types + corpus rows
  same fact editable in two places                   CONTAINED — recommendation
                                                       text dup'd in trace; chunk
                                                       text dup'd into meta; memory
                                                       text + convId dup'd into row
                                                       — all deliberate read opts
  frequent query with no supporting index            PRESENT-BY-DESIGN — vector
                                                       search is O(n) brute force,
                                                       no ANN index; memory recall
                                                       over-fetches k×4 then filters
                                                       on an UNINDEXED kind tag
  N+1 query pattern in app code                       N/A — batch reads only
  multi-write op with no transaction                  N/A — no multi-writes exist
  invariant enforced only in hopeful app code         MOSTLY — evals is async,
                                                       read-time; ONE exception:
                                                       retrieval dimension CHECK
                                                       is synchronous write-time.
                                                       memory id-uniqueness rests on
                                                       an UNENFORCED convId-unique
                                                       assumption
  destructive migration with no rollback              N/A — none has run; but the
                                                       read check is hard-fail on
                                                       schemaVersion !== 1
  relational schema vs document access mismatch       CLEAR — doc/KV storage,
                                                       matching access, consistent
  two entities in one collection, no real partition   PRESENT-BY-DESIGN — memory +
                                                       documents share one store,
                                                       split only by meta.kind (a
                                                       tag, not an index) — `07`
```

The finding to internalize: **AptKit's data integrity used to be only as good as the last time you ran the evals — and that's still true for everything except the corpus.** A database enforces constraints on every write, synchronously, no opt-out. AptKit enforces *artifact* constraints in `packages/evals`, asynchronously, only when invoked. The one place it now matches a database is `@aptkit/retrieval`'s dimension check: synchronous, write-time, no opt-out. So the honest one-liner is sharper than before — "one synchronous constraint, the rest run when you remember to," which is exactly the right tradeoff for a library whose persisted data is test fixtures and an in-memory corpus, not customer records.

---

## `not yet exercised` lenses — the full list

For quick reference, the relational concepts AptKit does **not** exercise, each with its nearest in-repo analog (the mapping is the teaching value):

| Relational concept | Status | Nearest AptKit analog |
| --- | --- | --- |
| SQL / DDL schema | not exercised | TypeScript types + `VectorChunk`/`VectorHit` row types (`contracts.ts:7-19`) |
| ORM | not exercised | `JSON.parse` + hand-written types |
| Ranked query / search | **exercised (no ANN index)** | `queryKnowledgeBase` → O(n) cosine scan + metadata filter (`pipeline.ts`, `search-knowledge-base-tool.ts`) |
| Indexes / query plans | not exercised | brute-force `Map` scan; `readdir` + filename `.sort()` (`replay-runner.ts:43`) |
| Foreign keys | **soft-exercised (no enforcement)** | `meta.docId` linkage on chunks (`pipeline.ts:44`); repeated `capabilityId` per event |
| Composite primary key | **exercised** | deterministic chunk id `"<docId>#<index>"` (`pipeline.ts:44`); memory id `"memory:<convId>:<n>"` (`conversation-memory.ts:82`) |
| Discriminator / partition key | **soft-exercised (tag, no index)** | `meta.kind` splits memory from document rows in one store (`conversation-memory.ts:84, 97`) — single-table inheritance, filtered client-side |
| Server-side `WHERE` filter | not exercised | over-fetch `k*4` then client-side `meta.kind` filter (`conversation-memory.ts:94-98`) — stand-in for SQL `WHERE` |
| Sequence / unique-id generator | not exercised | in-process counter `Map` per conversation (`conversation-memory.ts:71`); convId-uniqueness is *assumed*, not enforced (`:69-70`) |
| Transactions / atomicity | not exercised | single-file writes (atomic by construction) |
| Migrations / backfills | not exercised | `schemaVersion: 1` (reserved, never incremented) |
| `NOT NULL` / `CHECK` constraints | **enforced — read-time evals + one write-time** | `assertRequiredPaths` + per-field checks (`assertions.ts`); dimension `CHECK` (`in-memory-vector-store.ts:36-42`) |
| Normalization (declarative) | not exercised | denormalized `WorkspaceDescriptor`; `text`-into-`meta` chunk denorm |
