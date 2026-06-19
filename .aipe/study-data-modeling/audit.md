# Data-Modeling Audit — AptKit

Pass 1 of the audit-style shape: the seven data-modeling lenses, walked against the real repo. Each lens gets either a concrete finding (with `file:line` grounding) or an honest `not yet exercised`, plus the nearest in-repo analog so the relational concept still has a hook.

**The headline:** AptKit has no SQL/relational database, no ORM, no migration framework, no indexes, no foreign keys. Five of seven lenses are therefore `not yet exercised` *as relational concepts*. They are taught here as foundations the repo could adopt, each mapped to the AptKit thing that plays the same role today.

Ranked by what actually matters in this repo, worst-or-most-interesting first:

1. **Integrity** — exercised, and load-bearing (the evals layer is the only constraint enforcement).
2. **The data model / shape** — exercised (type-shaped + file-shaped).
3. **Migrations / evolution** — barely exercised (`schemaVersion: 1`, never yet incremented).
4. **Normalization / duplication** — one real duplication exists in the trace.
5. **Access patterns / storage choice** — exercised at the "flat files" level; relational-vs-document is moot.
6. **Indexing vs query patterns** — `not yet exercised` (no query engine, no indexes).
7. **Transactions** — `not yet exercised` (no multi-write atomicity anywhere).

---

## Lens 1 — The data model and its shape

**Exercised, type-shaped and file-shaped.** AptKit's schema is not in DDL, it's in TypeScript types and in the JSON files those types serialize to.

The three load-bearing schemas:

- **`WorkspaceDescriptor`** — `packages/context/src/workspace-descriptor.ts:18-28`. The domain entity model: one denormalized read-model carrying a project, its `events[]`, `customerProperties[]`, `catalogs[]`, and pre-aggregated `totalCustomers` / `totalEvents`. This is the closest thing to a relational schema in the repo. → full walk in `01-type-as-schema.md`.
- **`CapabilityEvent`** — `packages/runtime/src/events.ts:1-24`. A six-variant discriminated union; an append-only event-log schema. → `02-tagged-union-event-log.md`.
- **The replay artifact** — typed as `ReplayArtifact` / `QueryReplayArtifact` / `MonitoringReplayArtifact` / `DiagnosticReplayArtifact` in `apps/studio/src/types.ts:166-265`, persisted to `artifacts/replays/*.json`. The provider wire schema (`ModelRequest`/`ModelResponse`/`ModelMessage`/`ModelContentBlock`) lives in `packages/runtime/src/model-provider.ts:1-58`.

**Red-flag check — "everything in one JSON blob when the data has real structure":** *Not present.* The structure is real and modeled. The descriptor distinguishes events from catalogs from customer properties; the event union distinguishes six event types; the artifact distinguishes per-capability output (`recommendations` vs `anomalies` vs `diagnosis` vs `answer`). Nothing is dumped into an untyped bag.

## Lens 2 — Normalization and duplication

**Exercised, with one real (and deliberate) duplication.** The single source of truth principle is mostly honored, with one place it's violated for a reason.

The duplication: in a replay artifact, the agent's final output is stored **twice** — once as structured data (e.g. `recommendations[]` at `artifacts/replays/...sp-revenue-drop-w4-fixture-studio.json:14-79`) and again as a JSON string embedded inside the final `step` trace event's `content` field (same file, line 122). The recommendation text appears in both. Edit one, the other goes stale.

That's textbook denormalization — and it's the *right* call here. The structured array is what `packages/evals` validates and what `promote-replay-to-fixture.mjs` reads; the embedded string is what the Studio UI renders as the "raw model turn." They serve two different read paths, so storing the fact twice buys a faster read on each. It's a deliberate read optimization, not an accident — exactly the case the lens says is legitimate. → `02-tagged-union-event-log.md` and `01-type-as-schema.md` cover this.

A second, benign duplication: `capabilityId` repeats on every event in the `trace[]` array (`events.ts:1-24` — it's on all six variants). In a relational model that field would live once on the parent run row and be a foreign key, not be copied onto every child event. Here it's copied because each event is independently streamed over NDJSON and must be self-describing on the wire. → `02-tagged-union-event-log.md`.

**Red-flag check — "the same fact editable in two places":** *Present but contained.* The recommendation duplication is real; it's mitigated because the structured form is the source the tooling reads and the string form is generated from the same turn, never hand-edited.

→ The normalization *principle* (one fact, one home) is information-hiding for data. It's taught in `study-software-design`'s information-hiding concept; this audit applies it, it doesn't re-teach it.

## Lens 3 — Indexing vs query patterns

**`not yet exercised`.** There is no query engine, so there are no indexes and no query plans. Data is read one of two ways: (a) load a whole JSON file with `JSON.parse` (`replay-runner.ts:82-83`), or (b) `readdir` a directory and sort filenames (`listReplayArtifacts`, `replay-runner.ts:31-44`). There is no `WHERE`, no `JOIN`, no index to be missing.

**Nearest analog:** the directory listing sorted by filename (`.sort()` at `replay-runner.ts:43`) is a primitive ordered scan — the moral equivalent of a full table scan with an implicit sort on the timestamp-prefixed filename. If AptKit ever needed "find the latest artifact for capability X," that's the first query that would want an index; today it's an O(n) scan + filter over every file.

**Red-flag check — "frequent query with no supporting index" / "N+1":** *Not applicable.* No query layer exists to have these problems. The closest thing to N+1 — `evaluateReplayArtifactFiles` reading files in a loop (`replay-runner.ts:81-84`) — is fine, because it's a batch eval over a known small set, not a per-row fan-out on a hot path.

**Buildable target:** if artifact volume grows past a few hundred files, the move is *not* an index — it's to stop using the filesystem as a query store and move artifacts into SQLite or Postgres, at which point an index on `(capabilityId, createdAt)` becomes the obvious first index. That's a `study-system-design` decision (storage choice); the index shape is the data-modeling follow-on.

## Lens 4 — Transactions and integrity

**Integrity: exercised and load-bearing. Transactions: `not yet exercised`.** This split is the most important finding in the audit, so take the two halves separately.

**Integrity — yes.** Because the file layer has *no* write-time schema (JSON accepts anything), AptKit hand-rolls the constraint layer that a database would give for free. It lives in `packages/evals/src/assertions.ts` and `packages/evals/src/structural-diff.ts`. These functions are the repo's `NOT NULL` / type / `CHECK` constraints:

- `assertRequiredPaths` (`structural-diff.ts:49-51`) — the `NOT NULL` / required-column check.
- The per-field type checks in `assertReplayArtifactShape` (`assertions.ts:83-97`) — `schemaVersion !== 1`, `createdAt` must parse as a date, `durationMs >= 0`, `modelTurns >= 0`. These are `CHECK` constraints written by hand.
- `findSecretLikeString` (`assertions.ts:397-421`) — a constraint with no SQL analog at all: "no row may contain an API-key-shaped string." A data-exposure guard baked into the integrity layer.

→ full walk in `05-structural-diff-integrity.md`.

**Transactions — no.** There is no atomic multi-write anywhere. The one place it would matter is fixture promotion (`promote-replay-to-fixture.mjs`): it reads an artifact, reads the source fixture, then `writeFile`s a new promoted fixture (`:33`, `:40`, `:79`). If the process dies between reads and the write, nothing is corrupted (the write is the only mutation, and it's a single new file), so the lack of a transaction is safe *by construction* — every operation in the repo is single-file-write or read-only. There is no operation where two writes must succeed together.

**Red-flag check — "multi-write operation with no transaction" / "invariant enforced only in hopeful app code":** The first is *not present* (no multi-writes exist). The second is **the defining characteristic of the repo** — every invariant is enforced in app code (`packages/evals`), because there is no DB to enforce it. That's not a bug; it's the consequence of having no database. The honest framing: the evals layer is *good* hopeful-app-code — versioned, tested, run in CI — but it only fires when you run it. A hand-edited fixture that's never re-evaluated can violate every invariant silently.

## Lens 5 — Migrations and evolution

**Barely exercised.** The entire migration story is one field: `schemaVersion: 1`, set at write time (e.g. `apps/studio/src/replay-artifacts.ts:25`, `scripts/replay-model-recommendation.mjs:68`) and asserted at read time (`assertions.ts:83-85`, `apps/studio/vite.config.ts:1503` throws if `!== 1`).

It has never been incremented. There is no migration script, no backfill, no handler for "what if I see a `schemaVersion: 0` file." The version is a *seam reserved for a migration*, not a migration that's happened. → `03-versioned-artifact-schema.md` walks what's there and what a v1→v2 migration would actually require.

**Red-flag check — "destructive migration with no rollback" / "column drop with no backfill":** *Not applicable yet* — no migration has ever run. The latent risk: the read-side check is `!== 1` (hard fail), so the day the artifact shape changes, every old artifact on disk becomes unreadable in one step unless a migration is written first. That's the migration discipline `03` teaches before it's needed.

**Adjacent evolution that IS exercised:** fixture promotion (`04-fixture-promotion-lifecycle.md`) is a *data lifecycle* — live run → artifact → promoted fixture, with timestamps and provenance (`promotion.sourceArtifact`, `promotion.promotedAt` in the promoted JSON). That's versioning of recorded data, even though it's not schema migration.

## Lens 6 — Access patterns and storage choice

**Exercised at the "flat files on disk" level; relational-vs-document is moot.** AptKit's storage is the filesystem. Two access shapes:

- **Whole-object read** — fixtures and the `WorkspaceDescriptor` are always read entire, parsed, and used whole (`schemaSummary` consumes the full descriptor, `workspace-summary.ts:11-52`). Nothing reads a sub-field in isolation. This is a document-shaped access pattern, and the denormalized `WorkspaceDescriptor` shape matches it exactly.
- **Append + list** — artifacts are written once, never updated, and listed by filename (`replay-runner.ts:31-44`). Append-only, immutable. This matches the event-log model perfectly.

The storage *choice* (flat JSON files) is the right one for a library + preview tool: zero infra, git-diffable fixtures, trivially inspectable artifacts. The shape (denormalized documents, append-only log) matches the access pattern. There is no relational schema fighting a document access pattern, because there's no relational schema at all.

**Red-flag check — "relational schema fighting a document access pattern, or vice versa":** *Not present.* Document-shaped storage, document-shaped access. Consistent.

**The seam to system-design:** *when* to graduate from flat files to SQLite/Postgres is a `study-system-design` question (it's about infra and scale). The data *shape* once you do — keep `WorkspaceDescriptor` as a JSON column? split events into a child table? — is the data-modeling follow-on, and the answer flows from the access pattern: since the descriptor is always read whole, a JSONB column beats a normalized split.

## Lens 7 — Data-modeling red-flags audit (capstone)

The consolidated checklist, marked against AptKit:

```
  red flag                                          AptKit
  ────────────────────────────────────────────────  ──────────────────────────
  no discernible model (one untyped blob)            CLEAR — types model it
  same fact editable in two places                   CONTAINED — recommendation
                                                       text dup'd in trace, but
                                                       structured form is source
  frequent query with no supporting index            N/A — no query engine
  N+1 query pattern in app code                       N/A — batch reads only
  multi-write op with no transaction                  N/A — no multi-writes exist
  invariant enforced only in hopeful app code         PRESENT BY DESIGN — evals
                                                       is the only enforcement;
                                                       fires only when run
  destructive migration with no rollback              N/A — none has run; but the
                                                       read check is hard-fail on
                                                       schemaVersion !== 1
  relational schema vs document access mismatch       CLEAR — doc storage, doc
                                                       access, consistent
```

The one finding to internalize: **AptKit's data integrity is only as good as the last time you ran the evals.** A database enforces constraints on every write, synchronously, no opt-out. AptKit enforces them in `packages/evals`, asynchronously, only when invoked. That's the single most important thing to be honest about — and it's the right tradeoff for a library whose persisted data is test fixtures, not customer records.

---

## `not yet exercised` lenses — the full list

For quick reference, the relational concepts AptKit does **not** exercise, each with its nearest in-repo analog (the mapping is the teaching value):

| Relational concept | Status | Nearest AptKit analog |
| --- | --- | --- |
| SQL / DDL schema | not exercised | TypeScript types (`workspace-descriptor.ts`, `events.ts`) |
| ORM | not exercised | `JSON.parse` + hand-written types |
| Indexes / query plans | not exercised | `readdir` + filename `.sort()` (`replay-runner.ts:43`) |
| Foreign keys | not exercised | repeated `capabilityId` on every event (no enforcement) |
| Transactions / atomicity | not exercised | single-file writes (atomic by construction) |
| Migrations / backfills | not exercised | `schemaVersion: 1` (reserved, never incremented) |
| `NOT NULL` / `CHECK` constraints | enforced in app code | `assertRequiredPaths`, per-field checks in `assertions.ts` |
| Normalization (declarative) | not exercised | denormalized `WorkspaceDescriptor` read-model |
