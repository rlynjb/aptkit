# DB integration, serialized

**Subtitle:** Integration testing against a real database / serialized
test execution / environment-gated test suite — *Industry-standard*. Lives in
the companion repo **buffr**.

## Zoom out, then zoom in

Everything in aptkit is fast and offline because every expensive dependency is
faked (`01`). But a fake `InMemoryVectorStore` can't prove the *real* pgvector
binding works — cosine ranking in a JS array is not the same code as a Postgres
`<=>` operator over an `ivfflat` index. So there's exactly one place in the
whole system that runs against real infrastructure: buffr's `PgVectorStore`
tests. They're the integration layer the unit suite deliberately doesn't have.

```
  Zoom out — where the real-DB tests sit (in buffr, not aptkit)

  ┌─ aptkit (this repo) ──────────────────────────────────────────┐
  │  InMemoryVectorStore  — VectorStore contract, faked, unit-tested│
  │  fast, offline, no DB                                          │
  └───────────────────────────────┬────────────────────────────────┘
                                  │  same VectorStore contract
  ┌─ buffr (companion repo) ──────▼────────────────────────────────┐
  │  PgVectorStore  ★ REAL POSTGRES + pgvector ★                  │ ← here
  │  test: --test-concurrency=1, app_id='test', skip if no DB URL │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: these tests connect to a real Postgres, run the migration, upsert
768-dim vectors, and assert the planted chunk ranks on top via real cosine
search. They're serialized (`--test-concurrency=1`) because they share one
database, and skipped entirely when `DATABASE_URL` is unset so they never break
a developer's local run.

## Structure pass

**Layers:** the test → `PgVectorStore` → a real Postgres with the `agents`
schema.

**Axis — isolation / shared state: "what do two tests share, and how is it kept
from colliding?":**

```
  One axis: "what's shared, what isolates it?"

  ┌─ unit tests (aptkit) ─┐   share NOTHING (fresh InMemoryVectorStore each)
  └───────────┬───────────┘
              │  seam ═══════ ◄── shared state appears HERE
  ┌─ DB tests (buffr) ────┐   share ONE Postgres + one app_id='test' rows
  │  PgVectorStore         │   isolation = serialize + beforeEach DELETE
  └────────────────────────┘
```

**The seam:** the jump from in-memory (zero shared state) to a real database
(maximal shared state). Crossing it is where every isolation concern in the
whole system lives — and it's handled with three specific moves.

## How it works

### Move 1 — the mental model

You know the difference between testing a function that sorts an array and
testing a query against a live table: the first is hermetic, the second shares
a mutable resource with every other test that touches that table. The whole
craft of DB integration testing is keeping that shared resource from making
tests interfere — and making the suite *opt-in* so it doesn't break people who
don't have the DB.

```
  Real-DB integration test — three isolation moves

  ┌─ before (once) ──────────┐   connect pool + run migration
  ├─ beforeEach ─────────────┤   DELETE rows where app_id='test'  ← reset
  ├─ it: upsert + search ────┤   plant vectors, assert ranking
  ├─ after (once) ───────────┤   pool.end()
  └──────────────────────────┘
  whole suite: --test-concurrency=1   (serialize — one DB, no parallel writes)
               skip unless DATABASE_URL set  (opt-in)
```

The strategy in one sentence: **serialize the suite, reset rows before each
test, and skip the whole thing when there's no database.**

### Move 2 — the walkthrough

**The whole describe block is gated on an env var.** No `DATABASE_URL`, no run —
the suite is skipped, not failed:

```ts
// buffr/test/pg-vector-store.test.ts:12
describe('PgVectorStore', { skip: url ? false : 'set DATABASE_URL to run' }, () => {
```

This is the move that lets the unit-test philosophy and the integration-test
reality coexist. A developer with no Postgres gets a green run; CI with a
provisioned DB exercises the real path. The honest cost (audit lens 7): green
CI without the env var does **not** prove the pgvector binding — the integration
is only verified where `DATABASE_URL` is actually set.

**Setup once, reset before each test.** `before` connects the pool and runs the
schema migration; `beforeEach` deletes only the test rows:

```ts
// buffr/test/pg-vector-store.test.ts:14
before(async () => {
  pool = createPool(url!);
  const sql = await readFile(new URL('../../sql/001_agents_schema.sql', import.meta.url), 'utf8');
  await runMigration(pool, sql);
});
beforeEach(async () => {
  await pool.query("delete from agents.chunks where app_id = 'test'");   // reset
});
after(async () => { await pool.end(); });
```

The `app_id = 'test'` predicate is the isolation key: every test row is tagged
`'test'`, and `beforeEach` wipes exactly those rows, so one test's planted
vectors can't leak into the next. It deletes *only* `app_id='test'`, so it won't
nuke another app's data sharing the same database.

**The suite is serialized in the test script.** From `buffr/package.json:8`:

```
"test": "npm run build && node --test --test-concurrency=1 dist/test/*.test.js"
```

`--test-concurrency=1` runs test *files* one at a time. Because they all share
one Postgres and the same `app_id='test'` rows, parallel files would race on the
`beforeEach` DELETE and the planted-row assertions. Serializing trades speed for
correctness — the right call when the shared resource is a single mutable
database.

**The assertion is the real thing.** With a planted chunk and a distractor, it
asserts the planted one ranks first and the score is monotonic:

```ts
// buffr/test/pg-vector-store.test.ts:30
await store.upsert([
  { id: 'planted#0', vector: vec(5),   meta: { docId: 'planted', chunkIndex: 0, text: 'the planted passage' } },
  { id: 'other#0',   vector: vec(200), meta: { docId: 'other',   chunkIndex: 0, text: 'unrelated passage' } },
]);
const hits = await store.search(vec(5), 2);
assert.equal(hits[0]?.id, 'planted#0');
assert.ok(hits[0]!.score >= hits[1]!.score);
```

`vec(seed)` builds a 768-dim one-hot vector — deterministic, so the cosine
ranking is exact even against a real index. And the same dimension-mismatch
invariant tested for `InMemoryVectorStore` is re-tested here against Postgres
(`:42`, `assert.rejects(..., /dimension/)`) — the contract behaves identically
on both implementations.

```
  Layers-and-hops — the real-DB test path

  ┌─ Test ───────────┐ hop1: upsert(768-dim) ┌─ PgVectorStore ──────┐
  │  before: migrate  │ ─────────────────────►│  parameterized SQL    │
  │  beforeEach: reset │ hop4: hits ◄───────── │  insert / <=> search │
  └───────────────────┘                       └──────────┬───────────┘
                                       hop2 │ SQL over pool
                                            ▼
                              ┌─ Postgres + pgvector ──────────────┐
                              │  agents.chunks, app_id='test'       │
                              │  hop3: cosine rank via index        │
                              └──────────────────────────────────────┘
```

### Move 2 variant — the kernel

The kernel of a safe DB integration suite: **a reset between tests + serialized
execution + an env gate.** Remove the `beforeEach` reset and tests leak rows
into each other — order-dependent flake. Remove `--test-concurrency=1` and
parallel files race on the shared rows — nondeterministic failures. Remove the
env-var skip and every developer without Postgres gets a red suite for code
they didn't touch — and people learn to ignore red.

Optional hardening: the `app_id='test'` scoping (so the reset is surgical, not
a full table wipe) and the dimension-mismatch re-test (so the contract is
proven identical to the in-memory store).

### Move 2.5 — current vs future state

Right now this integration layer lives entirely in buffr, and aptkit's CI never
runs it. The contract (`VectorStore`) is the only thing tying the two
implementations together, and *nothing tests that they're interchangeable*
(audit lens 7, item 3). The buildable target: a shared contract test-suite —
the same set of assertions (`upsert replaces`, `search respects k`,
`dimension mismatch throws`, `planted chunk ranks top`) run against both
`InMemoryVectorStore` and `PgVectorStore`. Today those assertions are duplicated
by hand across two repos; a shared suite would catch a signature drift that
currently passes both green suites and only breaks at integration.

```
  Phase A (now)                      Phase B (target)
  ────────────                       ────────────────
  InMemory tests (aptkit)            shared VectorStore contract suite
  PgVector tests (buffr)             run against BOTH implementations
  duplicated assertions              one assertion set, two stores
  drift caught at integration        drift caught in CI
```

### Move 3 — the principle

The right number of integration tests is "as few as possible, but not zero."
Faking the database makes the unit suite fast; one real-DB suite proves the fake
isn't lying about the contract. The discipline that keeps it from being flaky is
the same everywhere: reset shared state between tests, serialize when the
resource is mutable and shared, and gate on the environment so the suite is
opt-in rather than a tax on everyone.

## Primary diagram

```
  DB integration, serialized — full picture

  GATE:     describe(skip: DATABASE_URL ? false : 'set DATABASE_URL')
  CONCURRENCY: node --test --test-concurrency=1   (one DB, one file at a time)

  ┌─ before ──────────┐  connect pool · run 001_agents_schema.sql migration
  ┌─ beforeEach ──────┐  DELETE FROM agents.chunks WHERE app_id='test'  (reset)
  ┌─ it ──────────────┐  upsert planted+distractor 768-dim vectors
  │                   │  search → assert planted#0 ranks first, score monotonic
  │                   │  assert dimension mismatch throws  (contract == in-memory)
  ┌─ after ───────────┐  pool.end()

  isolation key: every row tagged app_id='test'; reset wipes only those rows
```

## Elaborate

This is standard integration-test hygiene — transactional or delete-based
reset, serialized execution against shared resources, environment gating — but
it's worth a named file because it's the *only* place in the aptkit/buffr system
that crosses from faked to real infrastructure, and it's the proof that the
`VectorStore` contract (the load-bearing boundary in context.md) holds against a
real implementation. The architecture story — aptkit stays deployment-agnostic,
buffr fills the pgvector slot — is study-system-design. The testing story is
here: the contract is unit-tested with a fake on one side of the repo boundary
and integration-tested against Postgres on the other, with the open gap that
nothing yet proves the two are interchangeable in one run.

## Interview defense

**Q: You fake the vector store in unit tests — how do you know the real one
works?**

> One real-DB integration suite, in the deployment repo. It runs the actual
> migration, upserts 768-dim vectors into Postgres, and asserts the planted
> chunk ranks first via real cosine search. It's serialized with
> --test-concurrency=1 because every test shares one database, it resets rows
> tagged app_id='test' before each test, and the whole suite is skipped unless
> DATABASE_URL is set so it never breaks a local run. The fake keeps unit tests
> fast; this proves the fake isn't lying about the contract.

```
  before: migrate │ beforeEach: DELETE app_id='test' │ it: upsert+search+assert rank
  suite: --test-concurrency=1, skip if no DATABASE_URL
```

Anchor: *fake to stay fast; one real-DB suite to prove the contract — reset,
serialize, gate.*

**Q: Why serialize instead of running DB tests in parallel?**

> They share one Postgres and the same app_id='test' rows. In parallel, two
> files would race on the beforeEach DELETE and the planted-row assertions —
> nondeterministic failures. The fix is either a database-per-test (heavy) or
> serialize the suite. For a handful of tests, --test-concurrency=1 is the
> cheap correct answer; I trade speed for determinism where the resource is
> mutable and shared.

Anchor: *shared mutable resource → serialize or isolate; never race on it.*

## See also

- `01-injectable-transport-seam.md` — the in-memory fake on the other side of
  this contract.
- `02-fixture-replay-golden-master.md` — the other deterministic-replay layer.
- `audit.md` lens 4 (isolation/flakiness) and lens 7 (cross-repo contract gap).
- study-system-design / study-data-modeling — the `agents` schema and the
  aptkit-stays-agnostic / buffr-fills-the-slot architecture.
- study-database-systems — pgvector indexing and the `<=>` cosine operator.
