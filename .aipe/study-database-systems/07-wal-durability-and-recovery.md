# 07 — WAL, durability, and recovery

**Subtitle:** Write-ahead logging / fsync durability / crash recovery /
backup — *Industry standard* (taught), *analog: CapabilityEvent append-only
log (never replayed) + single writeFile (no fsync) + git as backup* (in-repo)

---

## Zoom out, then zoom in

Durability is the "D" in ACID: once you say "saved," a power cut can't undo
it. The mechanism is almost always a write-ahead log — append the *intent*
first, fsync it, then apply the change; on restart, replay the log to recover.
AptKit has the *shape* of a WAL sitting right there in `CapabilityEvent` — an
append-only, timestamped, ordered event stream — but it never replays it to
recover anything. And its actual durability boundary is a single `writeFile`
with no fsync. This file teaches WAL and recovery properly, then shows you the
WAL-shaped-but-not-WAL log and the thin durability the repo actually has.

```
  Zoom out — where durability lives (and the WAL-shaped thing that isn't a WAL)

  ┌─ Runtime layer ───────────────────────────────────────────┐
  │  CapabilityEvent[] ← append-only, timestamped event log    │ ← WAL SHAPE
  │  (events.ts) emitted by the agent loop, never replayed     │   (no recovery)
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Service layer ───────────▼───────────────────────────────┐
  │  writeFile(artifact)  ← the durability boundary, NO fsync  │ ← we are here
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ───────────▼───────────────────────────────┐
  │  filesystem + git history  ← "backup" is git commits       │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** Two questions: *when does AptKit consider a write durable, and
could a crash corrupt it?* and *what's the closest thing to a WAL, and why
isn't it one?* The durability boundary is "`writeFile` resolved" — earlier
than real durability, because no fsync. The WAL-shaped thing is the trace,
which is append-only and ordered but used for display/eval, not recovery.

---

## Structure pass

The layers: the **intent log** (`CapabilityEvent` trace) and the **durable
write** (`writeFile`). Axis to hold constant: **survival — what survives a
crash at this point, and can it be reconstructed?**

```
  One axis — "what survives a crash here?" — across the durability layers

  ┌───────────────────────────────────────────┐
  │ CapabilityEvent trace (in memory → in the │  → survives ONLY if the artifact
  │ artifact)                                 │    write succeeds; never used to
  └───────────────────────────────────────────┘    replay/rebuild → not recovery
      ┌───────────────────────────────────────┐
      │ writeFile(artifact) — no fsync        │  → "saved" returns before bytes
      └───────────────────────────────────────┘    are guaranteed on disk; a power
                                                    cut here can lose or truncate it
      ┌───────────────────────────────────────┐
      │ git commit of artifacts/              │  → survives a disk wipe IF you
      └───────────────────────────────────────┘    committed; the real "backup"

  the seam: the durability boundary is at writeFile-resolves, which is EARLIER
  than bytes-on-disk. Everything above it is volatile; only a git commit is
  durable across a machine loss.
```

The load-bearing seam is the gap between "AptKit says saved" and "the OS has
actually flushed to disk." A real WAL closes that gap with fsync on the log.
AptKit leaves it open and relies on git for the only durability that survives
hardware loss.

---

## How it works

### Move 1 — the mental model

You know how you write to a log file before doing risky work, so if it crashes
you can see how far you got? A write-ahead log is that, made authoritative:
the log *is* the source of truth, fsynced before the change is applied, and on
restart you replay the log to rebuild the data. The mental model: **WAL =
append the intent durably first, apply lazily, replay the log to recover after
a crash.**

```
  the real mechanism: write-ahead log + recovery

  normal:   intent ─► WAL.append(record) ─► fsync(WAL) ─► apply to pages
                                              ▲
                                "saved" is declared HERE (log is durable)

  crash + restart:
            read WAL from last checkpoint ─► replay each record ─► state rebuilt
            (committed records redone, uncommitted ones rolled back)
```

### Move 2 — the parts that matter

**The append-only log — `CapabilityEvent`.** A WAL is append-only, ordered,
and timestamped — you never edit a past log record, you only append new ones,
and order is the truth. `CapabilityEvent` is *exactly* that shape: a
discriminated union (`step`, `tool_call_start`, `tool_call_end`,
`model_usage`, `warning`, `error`), each carrying `capabilityId` and an ISO
`timestamp`, pushed onto a `trace` array as the agent runs and never mutated.
The trace sink only ever calls `trace.push(event)`. What breaks if it weren't
append-only: you couldn't trust replay order or reconstruct the run. So the
WAL *invariant* (append-only, ordered) holds.

```
  CapabilityEvent IS a WAL by shape — append-only, ordered, timestamped

  trace.push(step)          ┐
  trace.push(tool_call_start)│  only ever appended, never edited
  trace.push(model_usage)    │  order = truth; each has an ISO timestamp
  trace.push(tool_call_end)  ┘

  ...but nothing reads this back to REBUILD state. It's embedded in the
  artifact for display + eval (modelTurnCount, summarizeUsage). WAL shape,
  no recovery semantics.
```

**The missing recovery.** A WAL is only a WAL if something replays it to
recover. AptKit never does — there's no "on startup, read the trace and
reconstruct the agent's state." The trace is consumed for *observation*
(counting model turns, summing token usage, rendering the timeline in Studio),
not *recovery*. So crash recovery is `not yet exercised`. Trigger: you need to
resume an interrupted agent run, or rebuild current state from history — then
the trace becomes a real event-sourcing log.

**The durability boundary — single `writeFile`, no fsync.** Here's the part
that matters most operationally. AptKit declares an artifact "saved" the
moment `writeFile` resolves. But `writeFile` resolving means the data is in
the OS page cache — not necessarily on the physical disk. There's no
`fsync`, and no write-to-temp-then-`rename` (the standard atomic-replace
trick). What breaks: a power loss between `writeFile` resolving and the OS
flushing can lose the artifact, or worse, leave a *truncated* file that
`JSON.parse` later rejects. This is a torn-write exposure.

```
  AptKit's durability boundary is EARLY and the write is non-atomic

  JSON.stringify ─► writeFile ──resolves──► "saved!" ───► (later) OS flush ─► disk
                       │                       ▲                                ▲
                       │                       │                                │
                       │            AptKit trusts the data here      actually durable here
                       │
                       └─ no fsync, no temp+rename. A crash in the gap can
                          truncate the file → invalid JSON on next read.
                          A real WAL fsyncs the log to close this gap.
```

**Backup and restore — git.** The only durability that survives losing the
machine is git: `artifacts/replays/` and the promoted fixtures are committed
to the repo. "Restore" is `git checkout`. This is real but coarse — it
protects committed artifacts, not the ones you saved-but-didn't-commit, and
it's manual. Promoted fixtures get extra protection here because they're
treated as correctness baselines and committed deliberately.

### Move 3 — the principle

Durability is a *boundary*, and the whole game is knowing exactly where yours
is. A real engine pushes the boundary to "the WAL is fsynced" so a crash loses
nothing committed. AptKit's boundary is "writeFile resolved," which is cheaper
and earlier — fine for artifacts you can regenerate by re-running the agent,
dangerous for anything you can't. The generalizable rule: **know whether your
"saved" means in-memory, in-cache, or on-disk — and match that boundary to how
much it would hurt to lose the write.** AptKit's writes are regenerable, so an
early boundary is a defensible call; the WAL-shaped trace is one promotion away
from becoming a real recovery log if that ever changes.

---

## Primary diagram

```
  AptKit durability & "WAL" — the full picture

  ┌─ agent run (runtime) ─────────────────────────────────────┐
  │  emit step/tool/usage events → trace.push(...)            │
  │  CapabilityEvent[] : append-only, ordered, timestamped    │ WAL SHAPE
  │  (events.ts:1-24) ── consumed for display/eval, NOT replay │ (no recovery)
  └───────────────────────────┬───────────────────────────────┘
                              │ embedded in artifact.trace
  ┌─ save (service) ──────────▼───────────────────────────────┐
  │  writeFile(artifact)  ◄── durability boundary (NO fsync)   │
  │  non-atomic: crash → possible truncated file               │
  └───────────────────────────┬───────────────────────────────┘
                              │ commit (manual)
  ┌─ backup (git) ────────────▼───────────────────────────────┐
  │  git history of artifacts/ + fixtures/  ◄── survives wipe  │
  │  restore = git checkout                                    │
  └───────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The append-only log is built on every agent run (live or
replay). The thin durability boundary is hit on every save and every
promotion. Git backup is exercised whenever artifacts/fixtures are committed —
the promotion flow specifically produces files meant to be committed as
baselines.

**The WAL-shaped log** — `packages/runtime/src/events.ts:1-24` +
`apps/studio/vite.config.ts:539-543`:

```
  // events.ts — the record shape (a WAL entry)
  export type CapabilityEvent =
    | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
    | { type: 'tool_call_start'; ...; timestamp: string }
    | { type: 'model_usage'; ...; timestamp: string }
    | { type: 'error'; ...; timestamp: string };
                                          ↑ every variant carries an ISO timestamp

  // vite.config.ts — the append (the only mutation of the log)
  const traceSink = {
    emit: (event) => {
      trace.push(event);   ← APPEND-ONLY. Never edits a prior entry. Order = truth.
      options.onEvent?.(event);
    },
  };
       │
       └─ this is a WAL by structure. What makes it NOT a WAL: nothing replays
          `trace` to rebuild state — it's read by modelTurnCount/summarizeUsage
          for metrics and streamed to the UI, never for recovery.
```

**The durability boundary — no fsync** — `apps/studio/vite.config.ts:377`:

```
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        │
        └─ the ENTIRE durability story. No fsync → returns when data is in the
           OS cache, not on disk. No temp-file + rename → a crash mid-write can
           leave a partial file that fails JSON.parse on the next read
           (replay-runner.ts:83). "Saved" here is weaker than a DB's "committed."
```

**Promotion as a durable "commit" of a baseline** —
`scripts/promote-replay-to-fixture.mjs:76-79`:

```
  const outDir = resolve(repoRoot, args.values['out-dir'] ?? defaultOutDir);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${slugify(promotedId)}-${formatDateForFilename(...)}.json`);
  await writeFile(outPath, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');
       │
       └─ writes the authoritative baseline into fixtures/promoted/. This file
          is meant to be git-committed — that commit is the real durability
          step, the one that survives a machine loss.
```

---

## Elaborate

The write-ahead log is arguably the single most important idea in database
durability: by making the *log* the source of truth and fsyncing it before
touching the data pages, you turn a random-write durability problem into a
sequential-append one, and you get crash recovery for free by replaying. It's
also the backbone of replication (ship the log to a replica) and
point-in-time recovery (replay the log to a timestamp). AptKit has the log's
*shape* in `CapabilityEvent` but uses it for observability, not durability —
which is a perfectly common pattern (structured event traces) that just
happens to look like a WAL. The interesting consequence: AptKit is one feature
("resume an interrupted run from its trace") away from turning that trace into
a genuine event-sourcing recovery log. The trigger for real WAL/fsync
durability: artifacts become un-regenerable (a live run you can't reproduce)
and losing one is unacceptable — then you fsync, write-temp-and-rename, and
possibly replay the trace.

The *content* of the trace (what each event type means, the discriminated
union design) is `study-data-modeling`'s territory; the streaming transport of
the trace as NDJSON is `study-system-design`'s. This file owns only the
durability and recovery mechanics.

---

## Interview defense

**Q: "When you call something 'saved,' is it durable? What happens on a power
loss mid-write?"**

> Honestly, my durability boundary is early: "saved" means `writeFile`
> resolved, which is OS-cache, not on-disk — there's no fsync and no
> temp-and-rename. A power loss in that gap can lose the artifact or leave a
> truncated file that fails to parse on the next read. That's a defensible
> tradeoff because my artifacts are regenerable by re-running the agent, and the
> things I actually need to keep — promoted fixtures — are git-committed, which
> is the durability that survives losing the machine.

```
  writeFile resolves → "saved" (OS cache) ──gap──► disk flush
                          ▲                          (no fsync to close the gap)
                  boundary is HERE; git commit is the real durable line
```

**Anchor:** "The durability boundary is a single un-fsync'd `writeFile` at
`vite.config.ts:377`; git is the only crash-proof backup."

**Q: "You have an append-only timestamped event log. Is that a WAL?"**

> It has the shape — append-only, ordered, timestamped — but it's not a WAL,
> because nothing replays it to recover state. `CapabilityEvent` is consumed for
> metrics and the Studio timeline, not for rebuilding an interrupted run. It's a
> WAL one feature away from being one.

**Anchor:** "WAL shape, no recovery — `events.ts:1-24` is appended but never
replayed."

---

## Validate

1. **Reconstruct:** Draw a WAL write+recovery, then draw AptKit's durability
   boundary, and mark where "saved" is declared in each.
2. **Explain:** Why can a crash leave a corrupt artifact given
   `vite.config.ts:377`, and what two-line change (temp + rename) would prevent
   it?
3. **Apply:** You add live (non-fixture) runs whose results can't be
   regenerated. What durability changes does that force, and could the
   `CapabilityEvent` trace become a recovery log?
4. **Defend:** Argue why no-fsync + git-as-backup is the right durability story
   for AptKit's regenerable artifacts, and name the trigger to upgrade it.

---

## See also

- `05-transactions-isolation-and-anomalies.md` — the atomicity gap on a single write
- `08-replication-and-read-consistency.md` — shipping a WAL is how replicas sync
- `06-locks-mvcc-and-concurrency-control.md` — immutability of the written records
- `study-data-modeling` → the `CapabilityEvent` union and artifact schema
- `study-system-design` → NDJSON streaming of the trace
