# Data-Modeling Audit — AptKit

Pass 1 of the audit-style shape: the seven data-modeling lenses, walked against the real repo. Each lens gets either a concrete finding (with `file:line` grounding) or an honest `not yet exercised`, plus the nearest in-repo analog so the relational concept still has a hook.

**The headline:** AptKit has no SQL/relational database, no ORM, no migration framework, no foreign keys. But `@aptkit/retrieval` now adds a real store-shaped model — a vector corpus of `(id, vector, meta)` rows with a similarity-search query path and a write-time dimension `CHECK`. So the lens picture shifted: the data model, integrity, and (newly) the query-pattern lenses all have a store-shaped finding now, where before they were mostly type/file-shaped. Transactions and relational migrations remain `not yet exercised`, taught as foundations the repo could adopt.

Ranked by what actually matters in this repo, worst-or-most-interesting first:

1. **Integrity** — exercised and load-bearing. Two enforcement layers now: evals (async, read-time, the artifact constraints) **and** the retrieval store's dimension check (the repo's *first* synchronous write-time `CHECK`). → `06`.
2. **The data model / shape** — exercised (type-shaped + file-shaped + now **store-shaped**: the `VectorChunk`/`VectorHit` corpus rows). → `06`.
3. **Indexing vs query patterns** — *now partly exercised.* The retrieval package has a real query path (embed → cosine-rank → top-k) with a metadata filter, but it's a brute-force O(n) scan with no ANN index. The artifact side is still `not yet exercised`. → `06`.
4. **Normalization / duplication** — two real duplications: the recommendation-text-in-trace, and `text` copied into chunk `meta` for citations (a deliberate read denormalization). → `06`, `02`.
5. **Migrations / evolution** — barely exercised (`schemaVersion: 1`, never yet incremented).
6. **Access patterns / storage choice** — exercised at "flat files" + "in-memory `Map` corpus"; relational-vs-document is still moot. → `06`.
7. **Transactions** — `not yet exercised` (no multi-write atomicity anywhere).

---

## Lens 1 — The data model and its shape

**Exercised, type-shaped and file-shaped.** AptKit's schema is not in DDL, it's in TypeScript types and in the JSON files those types serialize to.

The load-bearing schemas:

- **`WorkspaceDescriptor`** — `packages/context/src/workspace-descriptor.ts:18-28`. The domain entity model: one denormalized read-model carrying a project, its `events[]`, `customerProperties[]`, `catalogs[]`, and pre-aggregated `totalCustomers` / `totalEvents`. This is the closest thing to a relational schema in the repo. → full walk in `01-type-as-schema.md`.
- **`CapabilityEvent`** — `packages/runtime/src/events.ts:1-24`. A six-variant discriminated union; an append-only event-log schema. → `02-tagged-union-event-log.md`.
- **The replay artifact** — typed as `ReplayArtifact` / `QueryReplayArtifact` / `MonitoringReplayArtifact` / `DiagnosticReplayArtifact` in `apps/studio/src/types.ts:166-265`, persisted to `artifacts/replays/*.json`. The provider wire schema (`ModelRequest`/`ModelResponse`/`ModelMessage`/`ModelContentBlock`) lives in `packages/runtime/src/model-provider.ts:1-58`.
- **The vector corpus** — `VectorChunk { id, vector, meta }` / `VectorHit { id, score, meta }` in `packages/retrieval/src/contracts.ts:7-19`. The repo's *only* store-shaped model: rows you `upsert` and `search`, not a type that serializes to a file. This is the closest thing to an actual database table in AptKit. → full walk in `06-vector-store-row-model.md`.

**Red-flag check — "everything in one JSON blob when the data has real structure":** *Not present.* The structure is real and modeled. The descriptor distinguishes events from catalogs from customer properties; the event union distinguishes six event types; the artifact distinguishes per-capability output (`recommendations` vs `anomalies` vs `diagnosis` vs `answer`). Nothing is dumped into an untyped bag.

## Lens 2 — Normalization and duplication

**Exercised, with one real (and deliberate) duplication.** The single source of truth principle is mostly honored, with one place it's violated for a reason.

The duplication: in a replay artifact, the agent's final output is stored **twice** — once as structured data (e.g. `recommendations[]` at `artifacts/replays/...sp-revenue-drop-w4-fixture-studio.json:14-79`) and again as a JSON string embedded inside the final `step` trace event's `content` field (same file, line 122). The recommendation text appears in both. Edit one, the other goes stale.

That's textbook denormalization — and it's the *right* call here. The structured array is what `packages/evals` validates and what `promote-replay-to-fixture.mjs` reads; the embedded string is what the Studio UI renders as the "raw model turn." They serve two different read paths, so storing the fact twice buys a faster read on each. It's a deliberate read optimization, not an accident — exactly the case the lens says is legitimate. → `02-tagged-union-event-log.md` and `01-type-as-schema.md` cover this.

A second, benign duplication: `capabilityId` repeats on every event in the `trace[]` array (`events.ts:1-24` — it's on all six variants). In a relational model that field would live once on the parent run row and be a foreign key, not be copied onto every child event. Here it's copied because each event is independently streamed over NDJSON and must be self-describing on the wire. → `02-tagged-union-event-log.md`.

A third duplication, in the retrieval corpus: the chunk's source `text` is copied into its `meta` at index time (`pipeline.ts:44`), so the same passage lives both in whatever produced it and in every chunk's metadata bag. This is deliberate — it's what lets the `search_knowledge_base` tool build a citation (`[docId] snippet…`) from a `VectorHit` alone, with no second lookup into a source-document store (there isn't one). Same legitimate-read-optimization shape as the recommendation duplication above. → `06-vector-store-row-model.md`.

**Red-flag check — "the same fact editable in two places":** *Present but contained.* The recommendation duplication is real; it's mitigated because the structured form is the source the tooling reads and the string form is generated from the same turn, never hand-edited.

→ The normalization *principle* (one fact, one home) is information-hiding for data. It's taught in `study-software-design`'s information-hiding concept; this audit applies it, it doesn't re-teach it.

## Lens 3 — Indexing vs query patterns

**Now partly exercised** — the retrieval corpus added a real query path, even though there's still no *index* in the B-tree/ANN sense.

**The artifact side is still `not yet exercised`.** Artifacts are read one of two ways: (a) load a whole JSON file with `JSON.parse` (`replay-runner.ts:82-83`), or (b) `readdir` a directory and sort filenames (`listReplayArtifacts`, `replay-runner.ts:31-44`). No `WHERE`, no `JOIN`, no index. The filename `.sort()` (`replay-runner.ts:43`) is a primitive ordered scan — the moral equivalent of a full table scan on a timestamp-prefixed key.

**The retrieval side IS a query path.** `queryKnowledgeBase` (`pipeline.ts:50-59`) runs embed → `store.search` → ranked top-k, and `InMemoryVectorStore.search` (`in-memory-vector-store.ts:25-33`) computes cosine similarity against *every* chunk, sorts descending, and slices `k`. The `search_knowledge_base` tool layers an exact-match metadata filter on top, over-fetching `topK * 4` so the post-filter still returns up to `topK` (`search-knowledge-base-tool.ts:87-90`). So there's a genuine ranked query with a predicate now — but the "index" is a brute-force linear scan, not an ANN structure (no HNSW, no IVF). It's O(n) over the corpus.

**Red-flag check — "frequent query with no supporting index":** *Present, but correctly so for an in-memory toy store.* The vector search has no ANN index — it scans the whole `Map` every query. That's the right call for the from-scratch in-memory adapter (a few thousand chunks max), and the explicit reason `PgVectorStore` is named as a drop-in behind the same contract (`in-memory-vector-store.ts:3-9`). **"N+1":** *Not present.* The closest thing — `evaluateReplayArtifactFiles` reading files in a loop (`replay-runner.ts:81-84`) — is a batch eval over a known small set, not a per-row fan-out on a hot path.

**Buildable target — two of them now.** For artifacts: if volume grows past a few hundred files, move them out of the filesystem into SQLite/Postgres and add an index on `(capabilityId, createdAt)`. For the corpus: when chunk count outgrows a linear scan, swap `InMemoryVectorStore` for a pgvector store with an HNSW/IVF index behind the same `VectorStore` contract — no pipeline change. Both are `study-system-design` storage decisions; the index *shapes* are the data-modeling follow-on. → `06`.

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
                                                       text dup'd into meta — both
                                                       deliberate read opts
  frequent query with no supporting index            PRESENT-BY-DESIGN — vector
                                                       search is O(n) brute force,
                                                       no ANN index (in-memory toy)
  N+1 query pattern in app code                       N/A — batch reads only
  multi-write op with no transaction                  N/A — no multi-writes exist
  invariant enforced only in hopeful app code         MOSTLY — evals is async,
                                                       read-time; ONE exception:
                                                       retrieval dimension CHECK
                                                       is synchronous write-time
  destructive migration with no rollback              N/A — none has run; but the
                                                       read check is hard-fail on
                                                       schemaVersion !== 1
  relational schema vs document access mismatch       CLEAR — doc/KV storage,
                                                       matching access, consistent
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
| Composite primary key | **exercised** | deterministic chunk id `"<docId>#<index>"` (`pipeline.ts:44`) |
| Transactions / atomicity | not exercised | single-file writes (atomic by construction) |
| Migrations / backfills | not exercised | `schemaVersion: 1` (reserved, never incremented) |
| `NOT NULL` / `CHECK` constraints | **enforced — read-time evals + one write-time** | `assertRequiredPaths` + per-field checks (`assertions.ts`); dimension `CHECK` (`in-memory-vector-store.ts:36-42`) |
| Normalization (declarative) | not exercised | denormalized `WorkspaceDescriptor`; `text`-into-`meta` chunk denorm |
