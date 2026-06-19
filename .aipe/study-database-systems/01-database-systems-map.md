# 01 — The database-systems map

**Subtitle:** Datastore topology / durability boundary — *Project-specific
(filesystem-as-store)*

---

## Zoom out, then zoom in

Okay — here's the whole thing. In a normal web app this diagram has a fat
box at the bottom labelled "Postgres" or "DynamoDB," a connection pool above
it, and a driver translating your calls into wire protocol. Find that box in
AptKit and you won't: there is no engine, no pool, no driver. The bottom
band is the filesystem, and the only thing that talks to it is the Vite dev
server's middleware.

```
  Zoom out — where the "datastore" lives in AptKit

  ┌─ UI layer (apps/studio) ──────────────────────────────────┐
  │  React replay shell → fetch()                             │
  └───────────────────────────┬───────────────────────────────┘
                              │  HTTP (localhost dev only)
  ┌─ Service layer (Vite middleware) ─────────────────────────┐
  │  ★ THIS FILE: the four query paths live here ★            │ ← we are here
  │  writeFile · readdir · readFile · validate                │
  └───────────────────────────┬───────────────────────────────┘
                              │  node:fs/promises
  ┌─ "Storage" layer (filesystem) ────────────────────────────┐
  │  artifacts/replays/*.json   ·   fixtures/promoted/*.json  │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question this file answers: *given that there's no engine,
what plays the role of one?* The answer is four code paths — write, read,
commit, validate — each a few lines of `node:fs`. Knowing where each lives
and what it does (and does not) guarantee is the map you need before any of
the later files make sense. The pattern is "filesystem as a single-writer
append-only store," and that's what we'll trace.

---

## Structure pass

Before the mechanics, read the skeleton. Three layers (UI, service,
filesystem). One axis held constant — **state ownership: who owns the bytes,
and is anything mutable?** Then the seams where that answer flips.

```
  One axis — "who owns the bytes, is it mutable?" — down the stack

  ┌───────────────────────────────────┐
  │ UI: React component state         │  → owns nothing durable; ephemeral
  └───────────────────────────────────┘
      ┌───────────────────────────────┐
      │ Service: Vite middleware      │  → owns the write decision, holds
      └───────────────────────────────┘    nothing; stateless between calls
          ┌───────────────────────────┐
          │ Filesystem: *.json files  │  → owns the bytes; APPEND-ONLY
          └───────────────────────────┘    (files written once, never edited)

  the answer flips at the bottom seam: above it, all state is ephemeral;
  below it, state is durable AND immutable-by-convention
```

**The load-bearing seam** is the bottom one — the `node:fs` boundary. Every
contract that a database would normally enforce (atomicity, durability,
ordering) either lives at this seam as a convention or doesn't exist:

- **Write contract:** the service writes a *new* file with a unique
  timestamped name. It never opens an existing file for update. That
  convention — not a lock — is what makes concurrent writes safe.
- **Read contract:** the service lists the directory and sorts filenames.
  The ordering guarantee depends entirely on the filename format being
  chronologically sortable as a string.
- **Durability contract:** none beyond "`writeFile` resolved." No fsync.

Those three are the joints. The mechanics below hang on them, and files
`02`–`08` each pick one joint and go deep.

---

## How it works

### Move 1 — the mental model

You already know the shape of a CRUD app: a handler takes a request, calls
the database, the database does the durable part, returns rows. AptKit is
that shape with the database box replaced by `node:fs/promises` and the
"rows" replaced by whole JSON files. The underlying strategy in one
sentence: **treat each saved artifact as an immutable file, name it so the
directory listing sorts itself, and validate shape only when you read it
back.**

```
  the pattern: file-per-record, write-once, list-to-query

         write                      read
   ┌──────────────┐          ┌──────────────────┐
   │ build object │          │ readdir(dir)     │
   │ in memory    │          │   ↓ filter .json │
   └──────┬───────┘          │   ↓ sort names   │  ← the "index"
          │                  │   ↓ readFile each│
          ▼                  │   ↓ JSON.parse   │
   ┌──────────────┐          │   ↓ validate     │  ← the "constraint"
   │ writeFile(   │          └──────────────────┘
   │  ts-slug.json)│                  ▲
   └──────┬───────┘                   │
          └────── never overwrites ───┘
                  (each write is a new row)
```

### Move 2 — the four paths, one at a time

**The write path.** This is the `/api/replay/save` middleware. You know how
an `INSERT` takes a row and the database picks where to put it? Here the
handler picks the location itself by constructing a filename, then writes
the whole object. What concretely happens: it normalizes the artifact
(a partial integrity check), builds a filename from
`createdAt + fixture.id + provider.id + '-studio'`, makes the directory if
needed, and writes. The boundary condition: the filename must be unique, or
the write silently clobbers a prior artifact. Uniqueness rides on the
millisecond-precision timestamp prefix.

```
  Layers-and-hops — the write path

  ┌─ UI ─────────┐ hop 1: POST /api/replay/save  ┌─ Service ────────┐
  │ replay shell │ ────────{ artifact } ───────► │ vite middleware  │
  └──────────────┘ hop 4: { path } ◄──────────── └────────┬─────────┘
                                            hop 2 │ normalize+name
                                                  ▼
                                         ┌─ Filesystem ──────┐
                                         │ writeFile(new.json)│  hop 3
                                         └────────────────────┘
```

**The read path.** This is `listReplayArtifacts` (for the CLI eval) and
`listReplaySummaries` (for Studio). Like a `SELECT * FROM replays ORDER BY
created_at`, except the "table" is a directory and the "ORDER BY" is a
filename sort. What concretely happens: `readdir` returns directory entries,
filter to `.json`, sort, then read and parse each one. The boundary
condition: this is a **full scan every time** — there is no index to consult,
so cost is O(number of files) for every list.

**The commit path.** This is `npm run promote:replay`. It takes one chosen
artifact and writes it into `fixtures/promoted/` as the new authoritative
baseline. Think of it as the moment you decide "this read is now the source
of truth" — a manual `COMMIT` of a specific record into a different table.
The boundary condition: promotion strips and rewrites the payload, so the
promoted file is a *derived* record, not a byte copy.

**The validate path.** This is `assertReplayArtifactShape` and friends. It's
the integrity layer, but it runs at read time. What concretely happens: the
parsed object is checked against a list of required paths plus type and
range rules. The boundary condition: nothing forces validation before a
write lands, so a bad artifact can sit on disk indefinitely.

### Move 3 — the principle

When you remove the database, you don't remove its *jobs* — you redistribute
them. AptKit pushed indexing into the filename, atomicity into the
write-once convention, and integrity into read-time assertions. That's the
generalizable lesson: a "no database" system is really a database whose
mechanisms are scattered across naming conventions and validation code.
Knowing which job lives where is how you reason about it.

---

## Primary diagram

The full map, every path and boundary labelled.

```
  AptKit persistence — all four paths, one frame

  ┌─ UI (apps/studio) ────────────────────────────────────────────┐
  │   AgentReplayShell                                            │
  └───┬──────────────────────────────────────────────┬───────────┘
      │ save                                          │ list
      ▼                                               ▼
  ┌─ Service (vite.config.ts) ────────────────────────────────────┐
  │  /api/replay/save (364-383)        /api/replays (349-362)     │
  │     normalize (1497) → writeFile      readdir → sort (983)    │
  │                                                               │
  │  promote:replay (script)            assertReplayArtifactShape │
  │     read+rewrite → writeFile           (assertions.ts:58)     │
  └───┬──────────────────────────────────────────────┬───────────┘
      │ append-only                                   │ full scan
      ▼                                               ▼
  ┌─ Filesystem ──────────────────────────────────────────────────┐
  │  artifacts/replays/*.json     fixtures/promoted/*.json        │
  │  durability boundary = writeFile resolves (NO fsync)          │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every time you click "Run" then "Save" in Studio, the write
path fires. Every time the replay shell lists prior runs, or `npm run
eval:replays` scores the directory, the read path fires. When you decide a
run is correct and want it as a deterministic test baseline, you run the
commit path. Validation rides along the read and commit paths.

**The read path, line by line** — `packages/evals/src/replay-runner.ts:31-44`:

```
  export async function listReplayArtifacts(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true }); ← the "table scan":
                                                               list the directory
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
                                          ← missing dir = empty table, not an error
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
                                          ← WHERE extension = '.json'
      .map((entry) => join(dir, entry.name))
      .sort();                            ← the ONLY index: lexicographic
                                            filename order (see file 03)
  }
       │
       └─ no index file, no metadata table — the directory IS the index,
          and .sort() on filenames IS the ORDER BY. Remove the timestamp
          prefix from filenames and this silently returns wrong order.
```

**The write path** — `apps/studio/vite.config.ts:364-383`:

```
  server.middlewares.use('/api/replay/save', async (req, res) => {
    ...
    const artifact = normalizeReplayArtifact(body.artifact); ← partial write-time
                                                                integrity check
    const outDir = resolve(workspaceRoot(), 'artifacts/replays');
    await mkdir(outDir, { recursive: true });                ← create "table" lazily
    const path = join(outDir,
      `${formatTimestamp(new Date(artifact.createdAt))}-${slugify(...)}-studio.json`);
                                          ← the filename IS the primary key + index
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
                                          ← the entire durability story: one write,
                                            no fsync, no temp-and-rename
    sendJson(res, { path: relativeFromWorkspace(path) });
  });
```

---

## Elaborate

This shape — file-per-record in a directory, listed and sorted to query — is
the oldest database there is. Maildir email storage, `git`'s loose-object
store, and log-structured systems all start here. The reason it works for
AptKit is the access pattern: write-rarely (a human clicks save),
read-occasionally (list a handful of runs), small N (8 artifacts today). A
real engine earns its complexity only when N grows, writes contend, or
queries need anything beyond "list and sort by time." File `09` names the
exact thresholds.

The data *shapes* flowing through these paths — the artifact schema, the
`CapabilityEvent` union — are owned by `study-data-modeling`. The *choice*
of filesystem over a database, and how it scales, is owned by
`study-system-design`. This file owns only the mechanism.

---

## Interview defense

**Q: "Your app saves data but has no database. Walk me through how a write
becomes durable and how you read it back."**

> There are four paths and no engine. A write is a `writeFile` of a whole
> JSON artifact into `artifacts/replays/`, named with an ISO timestamp prefix
> so the directory self-sorts. A read is `readdir` plus a `.sort()` on
> filenames — a full scan, no index. There's no transaction and no fsync, so
> "durable" means "writeFile resolved." The filename does triple duty: it's
> the primary key, the only index, and the uniqueness guard.

```
  write: build → name(ts-prefix) → writeFile   (no fsync)
  read:  readdir → filter .json → sort names → parse → validate
                                       ▲
                          the filename is PK + index + uniqueness
```

**Anchor:** "The filename is the index — `replay-runner.ts:43` is the whole
query planner."

---

## Validate

1. **Reconstruct:** From memory, name the four query paths and the one file
   each lives in.
2. **Explain:** Why does the read path in `replay-runner.ts:31-44` not need
   an index file?
3. **Apply:** A teammate renames artifacts to drop the timestamp prefix and
   use a random UUID. What breaks, and in which function
   (`replay-runner.ts:43` or `vite.config.ts:983`)?
4. **Defend:** Argue why filesystem-as-store was the right call for AptKit
   today, and name the one access-pattern change that would flip the
   decision.

---

## See also

- `02-records-pages-and-storage-layout.md` — the file-as-record cost model
- `03-btree-hash-and-secondary-indexes.md` — why the filename sort is the index
- `04-query-planning-and-execution.md` — the scan-filter-parse "plan" and its N+1
- `07-wal-durability-and-recovery.md` — the durability boundary in depth
- `study-system-design` → the filesystem-vs-database choice
- `study-data-modeling` → the artifact and event schemas
