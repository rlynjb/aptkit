# 02 — Records, pages, and storage layout

**Subtitle:** Record layout / page-oriented storage / the cost model of
persistence — *Industry standard* (taught), *analog: one JSON file per
record* (in-repo)

---

## Zoom out, then zoom in

A real engine spends enormous effort deciding how a row sits in bytes: which
columns are inline, which are pointers to overflow pages, how many rows pack
into one 8 KB page, where the page lives on disk. AptKit makes none of those
decisions — the "record" is a whole JSON file, the "page" is whatever the OS
hands `writeFile`, and the layout is "pretty-printed JSON, two-space
indent." So this file teaches the real mechanism and then shows you the
flat, no-tuning analog the repo actually uses.

```
  Zoom out — where the storage layout sits

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  (doesn't care how bytes are laid out)                    │
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Service layer ───────────▼───────────────────────────────┐
  │  JSON.stringify(artifact, null, 2)  ← serialization step   │
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ───────────▼───────────────────────────────┐
  │  ★ THIS FILE ★ one file = one record; OS picks the pages  │ ← we are here
  │  artifacts/replays/<ts>-<slug>.json                       │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question: *what is a "record" here, and what does it cost to
read or write one?* In a database the answer is "a tuple in a page, and the
cost is in page reads." In AptKit the answer is "a whole JSON document, and
the cost is one `readFile` + one `JSON.parse` per record, every time, with no
partial reads." That difference — no partial reads, no column projection — is
the entire lesson.

---

## Structure pass

Two layers matter for storage layout: the **logical record** (what the
program thinks it has) and the **physical bytes** (what's on disk). The axis
to hold constant: **cost — what does it take to read one field of one
record?**

```
  One axis — "cost to read one field" — across the layout layers

  ┌───────────────────────────────────────┐
  │ logical: artifact.provider.id         │  → a property access, O(1)
  └───────────────────────────────────────┘            ▲
      ┌───────────────────────────────────┐            │ but to GET here you
      │ physical: 4 KB+ of pretty JSON    │  → must readFile the WHOLE file
      └───────────────────────────────────┘    + JSON.parse the WHOLE thing
                                                  before that O(1) access exists

  the seam: there is no projection. Reading one field costs reading the
  entire record. A column store would flip this; AptKit cannot.
```

The seam here is the serialization boundary — `JSON.stringify` on write,
`JSON.parse` on read. It's load-bearing because it's all-or-nothing: you
cannot read half a record, and you cannot update one field in place. Every
file `03`–`07` inherits this: no partial reads means no real indexing inside
a record, no in-place update, no torn-row-but-readable-row recovery.

---

## How it works

### Move 1 — the mental model

You know how `JSON.parse(localStorage.getItem('key'))` gives you a whole
object you then read fields off? Scale that up: a database can't afford to
parse whole objects, so it lays records out as fixed-offset fields inside
fixed-size pages, and reads only the pages it needs. The mental model is a
**page = a fixed-size block that holds several records, and the engine reads
pages, not records.**

```
  the real mechanism: records packed into fixed-size pages

  ┌─ page (8 KB) ─────────────────────────────────┐
  │ ┌header┐ ┌rec 1┐ ┌rec 2┐ ┌rec 3┐ ... free──►  │
  │ │slots │ │ ◄───┘ │     │ │     │   space       │
  │ └──┬───┘ └──────┘ └──────┘ └──────┘            │
  │    └─ slot array points at each record's offset│
  └────────────────────────────────────────────────┘
   read one record  →  read its whole page  →  follow slot offset
```

AptKit's version collapses this: one record = one file, the OS chooses the
disk blocks, and you always read the whole thing.

### Move 2 — the parts that matter

**The record.** In a real engine a record is a byte layout: a header, then
each column at a known offset, with variable-length columns (strings) stored
as a length-prefix or an overflow pointer. The win is *projection* — read
only the columns the query asks for. In AptKit the record is the entire
artifact object (`schemaVersion`, `capabilityId`, `provider`, `fixture`,
`answer`/`recommendations`/`anomalies`/`diagnosis`, `trace`, `eval`,
`modelTurns`). There are no columns and no projection — you read all of it or
none of it.

**The page.** A page is the unit of I/O: the engine reads and writes whole
pages, caches them in a buffer pool, and dirties them on update. The point
of a page is *locality* — pack rows you read together into the same page so
one disk seek serves many rows. AptKit has no pages it controls; each file
is its own I/O unit, and there is no locality between two artifacts beyond
"same directory."

**Variable-length fields and overflow.** When a string is too big for the
page, real engines spill it to an overflow page and store a pointer. AptKit's
analog is interesting: the promotion script *forces all strings to ASCII* and
re-encodes, because the downstream format can't carry arbitrary Unicode
cleanly. That `asciiString` pass is the closest thing to an
overflow/encoding decision in the repo.

```
  AptKit's only "layout decision": ASCII-normalize on write (promotion)

  artifact.answer (may contain  “smart quotes”, em—dashes, …)
        │  asciiString()
        ▼
  promoted record (plain ASCII only)  ← deterministic bytes for replay
        │
        └─ this exists so the same record reproduces byte-for-byte later
           (the read-consistency story, file 08)
```

### Move 3 — the principle

Storage layout is a bet about access patterns. Pages and projection are the
right bet when you read a few columns of many rows and want them packed for
locality. Whole-file JSON is the right bet when you read entire records
rarely and value simplicity over I/O efficiency. AptKit took the second bet
because its records are read whole (the replay shell shows the entire
artifact) and read seldom. The generalizable rule: **layout follows the
read pattern — pick the layout that makes your hottest read cheap.**

---

## Primary diagram

```
  AptKit record/storage layout vs the real mechanism

  REAL ENGINE                          APTKIT
  ───────────                          ──────
  ┌ buffer pool (RAM) ┐                (no buffer pool — OS page cache only)
  │ cached pages      │
  └────────┬──────────┘
           │ page reads
  ┌ disk: 8KB pages ──┐                ┌ disk: one file per record ──┐
  │ [rec][rec][rec]   │                │ <ts>-<slug>.json (whole doc)│
  │ projection: read  │                │ no projection: readFile +   │
  │ only needed cols  │                │ JSON.parse the entire thing │
  └───────────────────┘                └─────────────────────────────┘
  cost: page reads                     cost: 1 readFile + 1 parse / record
```

---

## Implementation in codebase

**Use cases.** Serialization happens on every save (`/api/replay/save`) and
every promotion. The whole-record read happens on every list+display and
every eval pass. The ASCII-normalize layout decision happens only on
promotion, where deterministic bytes matter.

**The serialization (write) layout** — `apps/studio/vite.config.ts:377`:

```
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
                          │                            │  │      │
                          │                            │  │      └─ trailing
                          │                            │  │         newline (POSIX
                          │                            │  │         text convention)
                          │                            │  └─ 2-space indent: human
                          │                            │     readable, larger on disk
                          │                            └─ whole object, no field split
                          └─ the entire record serialized in one call
       │
       └─ pretty-printing trades disk size for diff-ability in git. With 8
          tiny artifacts that's free; at 10k records it's wasted bytes.
```

**The whole-record read** — `packages/evals/src/replay-runner.ts:82-84`:

```
  const raw = await readFile(path, 'utf8');   ← read the ENTIRE file, no seek
  const artifact = JSON.parse(raw) as unknown;← parse the ENTIRE document
  results.push(evaluateReplayArtifact(artifact, relativePath(cwd, path)));
       │
       └─ to check one field (capabilityId, eval.ok) the code parses the
          whole record. No projection exists — this is the cost model.
```

**The one layout decision — ASCII normalize** —
`scripts/promote-replay-to-fixture.mjs:105-112`:

```
  function asciiString(value) {
    return value
      .replace(/[‘’]/g, "'")   ← curly quotes → straight
      .replace(/[“”]/g, '"')
      .replace(/\s*[–—]\s*/g, ' - ') ← em/en dash → hyphen
      .replace(/…/g, '...')         ← ellipsis → three dots
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ''); ← drop everything non-ASCII
  }
       │
       └─ this is the repo's only "physical encoding" choice: normalize bytes
          so a promoted record reproduces identically on replay (file 08).
```

---

## Elaborate

The page/slot/overflow design comes from the need to amortize disk seeks:
when a seek costs 10 ms and a sequential read is cheap, you pack related rows
together and read them in one go. SSDs softened that, and column stores
inverted it (pack one column across many rows for analytics). AptKit sidesteps
the whole question because its working set is tiny and read-whole. The day
the artifact directory holds thousands of files and you only ever need
`capabilityId` and `createdAt` to render a list, you'd feel the absence of
projection — every list would parse every full document. That's the trigger
to introduce a real store (or at least an index file). See `09`.

The record *schema* — what fields an artifact has and why — is
`study-data-modeling`'s territory; this file only cares about how those
fields sit in bytes and what they cost to read.

---

## Interview defense

**Q: "What's the cost of reading a single field from one of your stored
records?"**

> The cost of reading the whole record. There's no projection — each artifact
> is one pretty-printed JSON file, so to get `eval.ok` I `readFile` the entire
> document and `JSON.parse` it. That's fine at 8 records read rarely; it's the
> first thing that hurts at scale, because a list view parses every full file.

```
  read one field:  readFile(whole) → JSON.parse(whole) → obj.field
                    └──────── cost is here, not at the field access ────────┘
```

**Anchor:** "One file is one record with no projection —
`replay-runner.ts:82` parses the whole document to read one field."

---

## Validate

1. **Reconstruct:** Draw a database page with three records and a slot array,
   then draw AptKit's equivalent.
2. **Explain:** Why can't AptKit read just `artifact.eval.ok` without parsing
   the whole file? Point to `replay-runner.ts:82-84`.
3. **Apply:** You need a list view showing 5,000 artifacts' `capabilityId` and
   `createdAt` only. What's the cost under the current layout, and what
   layout change makes it cheap?
4. **Defend:** Justify the 2-space-indent pretty-printing at
   `vite.config.ts:377` for today's repo, and name when you'd drop it.

---

## See also

- `01-database-systems-map.md` — where serialization sits in the map
- `03-btree-hash-and-secondary-indexes.md` — indexing across records
- `04-query-planning-and-execution.md` — the cost of scanning all records
- `study-data-modeling` → the artifact field schema and `schemaVersion`
