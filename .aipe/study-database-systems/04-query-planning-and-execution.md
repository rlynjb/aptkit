# 04 — Query planning and execution

**Subtitle:** Query plans / scans / joins / N+1 — *Industry standard*
(taught), *analog: readdir → filter → parse, with a real N+1 in the listing
endpoints* (in-repo)

---

## Zoom out, then zoom in

A query planner turns "what you want" into "how to get it" — pick an index or
a scan, choose a join order, decide whether to sort or stream. AptKit has no
planner because it has no query language; there is exactly one execution
strategy and it's hardcoded: list the directory, filter to JSON, read and
parse each file. That's the plan, every time. But there *is* one genuine
database pathology hiding in the Studio listing endpoints — an N+1 read where
each "row" triggers an expensive per-row operation. That one is worth the
whole file.

```
  Zoom out — where "query execution" lives

  ┌─ Service layer (the read endpoints) ──────────────────────┐
  │  /api/replays         → list + parse (cheap-ish)          │
  │  /api/promoted-*-fixtures → list + RE-RUN A REPLAY each   │ ← the N+1
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Capability layer (@aptkit/retrieval) ────────────────────┐
  │  VectorStore.search(vec,k) → scan + cosine + sort + topK  │ ← the real "query"
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ───────────▼───────────────────────────────┐
  │  artifacts/*.json · fixtures/*.json · in-mem VectorChunk  │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question: *what are AptKit's "query plans," and where do they
bite?* There are three. The disk read plan is a sequential scan with no index
assist and no join — and it bites in `listPromoted*FixtureSummaries`, which does
one directory scan *plus* a full agent replay per file (the canonical N+1, where
the "+1" is expensive). The third plan is the genuinely query-shaped one:
`InMemoryVectorStore.search` runs a `SCAN → SORT → LIMIT k` over embeddings —
ranking, not just listing — and its lack of an index is the lesson, not a bug.

---

## Structure pass

Two layers: the **declared intent** (list runs / list promoted fixtures with
their status) and the **execution** (the fixed `node:fs` + compute steps).
Axis to hold constant: **work per result row — what does producing one row of
the answer cost?**

```
  One axis — "work per result row" — across the two endpoints

  ┌───────────────────────────────────────────┐
  │ /api/replays                              │  → per row: readFile + parse +
  └───────────────────────────────────────────┘    shape assert  (I/O bound)
      ┌───────────────────────────────────────┐
      │ /api/promoted-*-fixtures              │  → per row: readFile + parse +
      └───────────────────────────────────────┘    RUN THE WHOLE AGENT replay
                                                    + behavior eval  (compute bound)

  the seam: same scan shape, wildly different per-row cost. The promoted
  endpoints turn a "list" into N agent executions — an N+1 where +1 is heavy.
```

The load-bearing seam is between "listing is cheap" and "listing secretly
executes work." A reader who assumes "list endpoint = cheap metadata read"
gets surprised: the promoted-fixture list endpoint replays every fixture
through the agent loop to recompute pass/fail. That's the surprise this file
exists to name.

---

## How it works

### Move 1 — the mental model

You know the classic ORM N+1: you fetch a list of authors, then loop and
fetch each author's books one query at a time — 1 query becomes 1 + N. A
query planner's job is partly to *avoid* that (turn it into a join). AptKit
has no planner to save you, so the N+1 is whatever the code loops over. The
mental model: **a "plan" here is a literal for-loop over directory entries,
and its cost is the loop body times N.**

```
  the pattern: scan = for-each-file, plan cost = N × (body cost)

  readdir(dir) ──► [ f1, f2, f3, ... fN ]
                      │   │   │       │
                      ▼   ▼   ▼       ▼      for EACH file:
                   ┌────────────────────┐     readFile
                   │  loop body runs N  │     JSON.parse
                   │  times, serially   │     (cheap path) assert shape
                   └────────────────────┘     (N+1 path) RUN AGENT REPLAY
                                               + behavior eval
  total = N × body.  When body is "run an agent," this is the N+1.
```

### Move 2 — the parts that matter

**The scan.** Every read endpoint starts the same way: `readdir`, filter to
`.json`, then a `for` loop. There's no index to consult, so it's always a
full scan — a `SELECT *` with no `WHERE` pushdown. What concretely happens in
the cheap path (`/api/replays`): per file, `readFile` + `JSON.parse` +
`assertCapabilityReplayArtifactShape` + a usage/cost summary, then push a
summary object. Boundary condition: cost grows linearly with directory size,
and there's no pagination — the whole directory is materialized per request.

**The filter and projection (absent).** A planner pushes `WHERE` down to the
index so it never reads non-matching rows, and pushes projection down so it
reads only needed columns. AptKit does neither: it reads every full record,
then any filtering would happen in memory afterward. There's no `WHERE`
pushdown and no projection (see `02`). The directory scan reads everything.

**The join (absent, but promotion is a 2-source read).** There are no joins —
no operation relates two record *sets*. The closest shape is promotion, which
reads two files (the source fixture and the replay artifact) and merges them
into one output (`promote-replay-to-fixture.mjs:33-40, 44-74`). That's a
nested-loop join with cardinality 1×1 — a point read of each side, merged.
Real joins (`N×M`, hash join, merge join) are `not yet exercised`; the
trigger is "you need to relate two collections of records by a key."

**The N+1 — the real pathology.** This is the one worth memorizing.
`listPromotedFixtureSummaries` (and its monitoring/diagnostic/query siblings)
scans the promoted-fixtures directory and, *for each file*, calls
`runReplay(fixture, 'fixture')` — a full agent loop execution — then runs a
behavior eval. So listing M promoted fixtures executes M agent replays
serially. What breaks: a "show me my baselines" request is secretly O(M
agent runs), and adding one baseline adds one full replay to every page load.

```
  the N+1, concretely (listPromotedFixtureSummaries, vite.config.ts:986-1030)

  readdir(promoted/) ──► [ fixture1.json ... fixtureM.json ]
                              │
            for each ─────────┤
                              ▼
                   runReplay(fixture, 'fixture')   ← +1: a FULL agent loop
                   assertBehavioralExpectations()  ←     + structural eval
                   summarizeUsage / estimateCost
                              │
                              ▼
                   push one summary row

  1 scan  +  M agent executions  =  classic N+1, where +1 is heavy
```

**The cosine top-k scan — the new, genuinely query-shaped path.** Everything
above is a *list*; this one is a *query* with ranking. `@aptkit/retrieval`'s
`InMemoryVectorStore.search(vector, k)` is the closest the repo gets to a real
`SELECT ... ORDER BY ... LIMIT k` execution. The "plan" is fixed and has three
operators in sequence: a **sequential scan** (compute cosine similarity against
every stored chunk — no index narrows it), a **sort** (descending by score),
and a **limit** (`slice(0, k)`). What concretely happens: it iterates
`this.chunks.values()`, scores each, sorts the full result set, and returns the
top k. Boundary condition: cost is O(N·d) for the scan plus O(N log N) for the
sort — linear in corpus size, which is exactly the cost an ANN index exists to
eliminate (see `03`). One operator is *missing* versus a real planner: there's
no `WHERE` pushdown. The `search_knowledge_base` tool's metadata filter runs
*after* the scan (`search-knowledge-base-tool.ts:88-90`), over-fetching `topK*4`
then filtering in memory — a post-scan filter, not a pushed-down predicate.

```
  the cosine top-k plan (InMemoryVectorStore.search, in-memory-vector-store.ts:25-33)

  query vector q
       │
       ▼
  ┌─ SCAN ──────────────────────────────────┐  for each of N chunks:
  │  score = cosineSimilarity(q, chunk)      │    O(d) work, O(N) chunks
  └────────────────────┬────────────────────┘    → O(N·d), no index assist
                       ▼
  ┌─ SORT ──────────────────────────────────┐  hits.sort(desc by score)
  │  ORDER BY score DESC                     │    O(N log N)
  └────────────────────┬────────────────────┘
                       ▼
  ┌─ LIMIT ─────────────────────────────────┐  slice(0, k)
  │  LIMIT k                                 │    top-k returned
  └─────────────────────────────────────────┘

  the tool layer adds a POST-scan filter (over-fetch k×4, filter in memory) —
  a predicate that a real planner would push into the index, here run after.
```

### Move 3 — the principle

Without a planner, your "query cost" is exactly the shape of the loop you
wrote — there's nothing optimizing it behind your back, for better or worse.
The promoted-fixture endpoints prove the danger: a listing that looks like
cheap metadata is actually N agent runs because the only way to know a
baseline's pass/fail is to recompute it. The generalizable rule: **when there's
no engine to fold work into a set operation, every per-row cost is paid in
full and serially — so watch what your "list" loop actually does per item.**

---

## Primary diagram

```
  AptKit query execution — two plans, same scan, different per-row cost

  ┌─ /api/replays (cheap read) ───────────────────────────────┐
  │  readdir → filter .json → FOR EACH:                       │
  │     readFile · parse · assertShape · summarizeUsage       │  O(N) I/O
  │  → sort by createdAt desc → return                        │
  └────────────────────────────────────────────────────────────┘

  ┌─ /api/promoted-*-fixtures (the N+1) ──────────────────────┐
  │  readdir → filter .json → FOR EACH:                       │
  │     readFile · parse · runReplay(agent loop!) ·           │  O(M agent runs)
  │     behavior eval · summarizeUsage · estimateCost         │
  │  → sort by id → return                                    │
  └────────────────────────────────────────────────────────────┘
                                  ▲
                    the "+1" is a full agent execution per file
```

---

## Implementation in codebase

**Use cases.** The cheap scan runs whenever Studio lists prior runs or the
CLI evaluates the directory. The N+1 runs whenever Studio opens a
promoted-fixtures panel — each of the four capabilities has its own endpoint,
each re-running its agent per baseline file.

**The cheap scan** — `packages/evals/src/replay-runner.ts:81-94`:

```
  for (const path of paths) {                       ← the for-loop IS the plan
    const raw = await readFile(path, 'utf8');        ← per-row I/O
    const artifact = JSON.parse(raw) as unknown;     ← per-row parse (whole doc)
    results.push(evaluateReplayArtifact(artifact, relativePath(cwd, path)));
  }                                                  ← per-row shape assertion
  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, checked: results.length, failed: failed.length, results };
       │
       └─ no index, no pushdown: reads + parses every file every call. Cheap
          at N=8; linear forever.
```

**The N+1** — `apps/studio/vite.config.ts:996-1027`:

```
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== '.json') continue;
    const path = join(dir, entry.name);
    const fixture = JSON.parse(await readFile(path, 'utf8')) as RecommendationFixture;
    const replay = await runReplay(fixture, 'fixture');   ← +1: runs the FULL
                                                          │   recommendation agent
                                                          │   loop, per file
    const behavior = assertBehavioralExpectations(replay.recommendations, fixture.expectations);
    const usage = summarizeUsage(replay.trace);           ← plus eval + cost per row
    const costEstimate = estimateCost(...);
    summaries.push({ ... });
  }
       │
       └─ M promoted fixtures ⇒ M agent replays, serial, on one HTTP request.
          The same shape repeats at lines 1042 (monitoring), 1088 (diagnostic),
          1134 (query). It's deterministic and fast today (fixture mode, tiny M),
          but it is structurally an N+1.
```

**The 1×1 "join" in promotion** — `scripts/promote-replay-to-fixture.mjs:33-40`:

```
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));   ← side A
  ...
  const sourceFixturePath = resolve(repoRoot, artifact.fixture.path);
  const sourceFixture = JSON.parse(await readFile(sourceFixturePath, 'utf8')); ← side B
       │
       └─ reads two records and merges them — a nested-loop join of cardinality
          1×1. The artifact's fixture.path is the join key (a foreign-key-like
          reference into the fixtures "table").
```

**The cosine top-k query** — `packages/retrieval/src/in-memory-vector-store.ts:25-33`:

```
  async search(vector, k) {
    this.assertDimension(vector, 'query vector');
    const hits = [];
    for (const chunk of this.chunks.values())        ← SCAN operator: O(N)
      hits.push({ id: chunk.id,
        score: cosineSimilarity(vector, chunk.vector), ← O(d) score per row
        meta: chunk.meta });
    hits.sort((a, b) => b.score - a.score);          ← SORT operator: ORDER BY DESC
    return hits.slice(0, Math.max(0, k));            ← LIMIT operator: top-k
  }
       │
       └─ a fixed three-operator plan (scan→sort→limit). No index, no WHERE
          pushdown. The metadata filter lives one layer up, AFTER this returns:
          search-knowledge-base-tool.ts:88-90 over-fetches k×4 and filters in
          memory — a post-scan predicate, not a pushed-down one.
```

---

## Elaborate

The query planner is one of the deepest pieces of a real database: cost
models, statistics, join-order search, index selection. AptKit needs none of
it because it has one collection, one access pattern, and tiny N — the
optimal plan is obvious (scan it). The N+1 in the promoted-fixture endpoints
is tolerable today for the same reason: fixture-mode replay is deterministic
and fast, and M is single digits. But it's the textbook setup for a
slow-listing incident — the day fixtures multiply or replay gets expensive,
that endpoint is the first to degrade. The fix isn't a query planner; it's
caching the computed pass/fail alongside the fixture so listing reads
metadata instead of recomputing. That's the trigger, and it's flagged in
`09`.

The relationship *shapes* between artifacts and fixtures (the `fixture.path`
foreign-key-like reference) are `study-data-modeling`'s concern; this file
only cares about the execution cost of resolving them.

---

## Interview defense

**Q: "You have a listing endpoint. What does it cost to render the list?"**

> Depends which list. `/api/replays` is a directory scan: read + parse +
> shape-assert every file — linear, I/O bound. But the *promoted-fixtures*
> listing is an N+1: for each baseline file it re-runs the full agent replay to
> recompute pass/fail, so listing M baselines is M agent executions on one
> request. It's fast today because replay is deterministic and M is tiny, but
> structurally it's the classic 1+N you'd cache away.

```
  list M baselines → readdir(1) + runReplay × M  →  N+1 (the +1 is an agent run)
```

**Anchor:** "The N+1 is `runReplay` inside the listing loop —
`vite.config.ts:1001`."

---

## Validate

1. **Reconstruct:** Draw the scan loop and mark where the "+1" expensive work
   happens in the promoted-fixture path.
2. **Explain:** Why is `/api/replays` cheaper per row than
   `/api/promoted-fixtures`? Cite `replay-runner.ts:82` vs `vite.config.ts:1001`.
3. **Apply:** You have 200 promoted fixtures and the panel times out. Without
   adding a database, what change removes the N+1?
4. **Defend:** Argue why the N+1 was an acceptable tradeoff when the repo had a
   handful of fixtures, and name the threshold where it stops being acceptable.

---

## See also

- `02-records-pages-and-storage-layout.md` — why each row read parses a whole file
- `03-btree-hash-and-secondary-indexes.md` — why there's no `WHERE` pushdown,
  and why the cosine scan has no ANN index
- `09-database-systems-red-flags-audit.md` — the N+1 and the linear-scan vector
  search ranked as risks
- `study-system-design` → caching the computed status to kill the N+1
- `study-ai-engineering` / `study-agent-architecture` → the RAG retrieval that
  this `search` powers
