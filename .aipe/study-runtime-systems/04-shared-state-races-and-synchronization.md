# 04 — Shared State, Races, and Synchronization

**Industry name:** concurrency hazards / synchronization · *Industry standard*

## Zoom out, then zoom in

This concept asks: what mutable state is shared, and can two flows corrupt it? In AptKit the answer is shaped by the single-threaded model — the band where races *could* live is mostly empty.

```
  Zoom out — where shared mutable state could live

  ┌─ Per-run state (stack/heap of one async call tree) ──────────┐
  │  messages[], toolCalls[], FixtureModelProvider.index         │ ← isolated per run
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Process-wide state ─────▼───────────────────────────────────┐
  │  ★ none mutated concurrently — no module-level mutable cache ★│ ← we are here
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Cross-process state ────▼───────────────────────────────────┐
  │  ★ filesystem: artifacts/replays + fixtures/promoted ★       │ ← the ONE race surface
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a *race condition* is when two flows interleave on shared mutable state and the result depends on timing. In a threaded language you'd reach for a mutex. In AptKit the in-memory race surface is essentially zero — because the event loop never interrupts a synchronous block, and because each agent run owns its own state. The only real race surface is the **filesystem**, where two processes (or two requests) could write the same path. That relocation of the hazard — from memory to disk — is the whole story here.

## Structure pass

**Layers.** Per-run state → process-wide state → cross-process (disk) state, as above.

**Axis — "who can mutate this, and can two mutate it at once?"**

```
  One question down the layers: "can two flows mutate this simultaneously?"

  ┌─ per-run (messages[], index) ─┐  NO — one run owns it; even if two runs
  │                               │  exist, each has its own array
  └──────────────┬────────────────┘
       ┌─────────▼──────────────────┐ NO — no module-level mutable shared
       │  process-wide              │  cache that two requests both write
       └─────────┬──────────────────┘
           ┌─────▼────────────────────┐ YES — two processes can write the
           │  filesystem (replays)    │  same .json path; last-write-wins
           └──────────────────────────┘
```

The race answer is "no" at every in-memory layer and flips to "yes" only at the disk layer. That's the seam to study.

**Seams.** The load-bearing seam is the **filesystem write** in the promote/save paths. Within one process the event-loop's run-to-completion is itself the "lock" — a synchronous mutation can't be interrupted. Across processes there is no lock, and the contract is "whoever writes last wins."

## How it works

### Move 1 — the mental model

You know that in React you never mutate state two components share without a single owner, because you can't predict render order. Single-threaded JS gives you a stronger guarantee than React: between two `await`s, *nothing* else runs, so a synchronous mutation is atomic by construction. The strategy here: **isolation by ownership (each run owns its state) + atomicity by run-to-completion (sync blocks can't interleave).**

```
  Why there's no in-memory race — run-to-completion is the lock

  task A:  read x ─ modify x ─ write x   (all synchronous, ONE block)
           └────────── atomic ──────────┘   nothing interleaves here
  task B:                                   only runs after A's block ends,
           read x ─ ...                      or while A is parked at an await
```

### Move 2 — walking the mechanism

**Per-run state is born fresh and never shared.** Every `runAgentLoop` call allocates its own `messages` and `toolCalls` arrays at the top of the function. Two concurrent replays have two separate arrays on two separate async call trees. There's no module-level `let currentMessages` they both touch.

```
  Per-run isolation — two runs, two heaps-worth of state

  run #1 (request A):  messages_A = [...]   toolCalls_A = [...]
  run #2 (request B):  messages_B = [...]   toolCalls_B = [...]
       │                                         │
       └──── no overlap ─────────────────────────┘  (separate closures)
```

**Mutation across an await is the one thing to watch — and it's safe here because state is single-owner.** The classic single-threaded race is: read a shared value, `await` (other code runs and changes it), then write back a stale value. AptKit's per-run arrays are only mutated by their own loop iteration, never by a concurrent run, so the "other code changes it" half can't happen.

```
  The single-threaded race (NOT present here) vs what AptKit does

  THE RACE (avoided):              AptKit (safe):
    x = shared.count               x = messages   (this run's only)
    await something()              await model.complete()
    shared.count = x + 1           messages.push(...)
       ▲ stale if another             ▲ no other flow touches THIS
         flow wrote shared.count        run's messages — single owner
```

**`FixtureModelProvider.index` is mutable but single-owner.** Each replay constructs a *new* `FixtureModelProvider` with its own `index` counter that walks the canned responses. Because the provider instance is per-run, the counter is never shared — no two runs increment the same `index`.

**The filesystem is the real race surface — and it's last-write-wins.** Two promote operations targeting the same output filename, or a save racing a read, have no lock. The mitigation isn't a mutex; it's *naming*: output paths embed a timestamp and a slug, so two distinct runs rarely collide. `promoteCapabilityReplayArtifact` builds `${slugify(promotedId)}-${formatDateForFilename(...)}.json`, and the Studio save embeds a full ISO timestamp. Collisions require same fixture + same provider + same second.

```
  Cross-process write — no lock, collision-avoided by naming

  process A: write artifacts/replays/2026-06-19T10-30-00-...-studio.json
  process B: write artifacts/replays/2026-06-19T10-30-05-...-studio.json
       │                              │
       └─ different timestamps ───────┘  → different paths → no collision
          (if timestamps matched to the second: last write wins, no error)
```

### Move 3 — the principle

Single-threaded JS doesn't eliminate concurrency hazards — it *relocates* them. In-memory races vanish (run-to-completion + single-owner state), and the hazard reappears at every boundary the loop doesn't own: the filesystem and the remote provider. The skill is knowing the hazard moved, not assuming it's gone. AptKit handles the relocated hazard the pragmatic way — collision-avoidant naming instead of locks — which is correct for low-contention, append-mostly artifact writes.

## Primary diagram

```
  Synchronization map — hazard relocated from memory to disk

  ┌─ In-memory (one process) ────────────────────────────────────┐
  │  per-run state: messages[], toolCalls[], fixture.index       │
  │  ─ isolated per run (single owner)                           │
  │  ─ atomic mutation (run-to-completion between awaits)        │
  │  ─ NO locks needed, NO module-level shared mutable state     │
  └──────────────────────────┬───────────────────────────────────┘
                             │ writes
  ┌─ Filesystem (cross-process) ─▼───────────────────────────────┐
  │  artifacts/replays/*.json, fixtures/promoted/*.json          │
  │  ─ the ONE shared mutable surface                            │
  │  ─ no lock; collision avoided by timestamp+slug naming       │
  │  ─ contention model: last-write-wins                         │
  └───────────────────────────────────────────────────────────────┘
       NO mutex · NO semaphore · NO Atomics · NO SharedArrayBuffer
```

## Implementation in codebase

**Use cases.** You reason about this whenever two things might touch the same data: two Studio tabs replaying at once (safe — separate per-run state), a promote running while a list reads the directory (safe enough — append-mostly, distinct names), or someone proposing a module-level cache (would *introduce* a race the current code avoids).

**Code side by side.**

Per-run state allocated fresh — the isolation:

```
  packages/runtime/src/run-agent-loop.ts (lines 94–96)

  const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }]; ← this run's only
  const toolCalls: ToolCallRecord[] = [];                                    ← this run's only
  let finalText = '';
       │
       └─ closed over by THIS invocation. A second concurrent runAgentLoop
          gets its own three bindings. No sharing → no race.
```

Single-owner mutable counter in the fixture provider:

```
  packages/agents/recommendation/src/fixture-provider.ts (lines 11–17)

  async complete(request) {
    this.requests.push(request);
    const response = this.responses[this.index];  ← reads this instance's counter
    this.index += 1;                              ← mutates it — but instance is per-run
    if (!response) throw new Error(`fixture model exhausted...`);
    return response;
  }
       │
       └─ a NEW FixtureModelProvider per replay (see vite.config.ts:756) means
          index is never shared between runs
```

Collision-avoidant naming instead of a lock:

```
  apps/studio/vite.config.ts (lines 1356–1360)  — promote write

  const outPath = join(outDir,
    `${slugify(promotedId)}-${formatDateForFilename(artifactDate)}.json`); ← timestamped name
  await writeFile(outPath, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');
       │
       └─ no flock/mutex. Two promotes collide only if name matches exactly;
          the embedded timestamp makes that practically impossible
```

## Elaborate

The "no locks because single-threaded" property is the flip side of "no parallelism" from `02` — you give up multi-core throughput and get freedom from an entire bug class in return. The hazard relocation to the filesystem is the same pattern you'd see in any local-first system: in Rein's `dryrun` and `buffr` the canonical store is local (GitHub-as-backend / SQLite), and the coordination problem moves to *sync*, not in-memory locking. AptKit is simpler still — it doesn't even sync; it just appends timestamped artifacts. `not yet exercised` here: mutexes, semaphores, `Atomics`, `SharedArrayBuffer`, optimistic concurrency control, file locking (`flock`). They'd become relevant the moment two writers genuinely contend for one path under load — which the current usage (manual Studio promotes, sequential script runs) doesn't produce.

## Interview defense

**Q: "Single-threaded, so no races — true?"**

```
  in-memory:  run-to-completion + single-owner state  →  no race ✓
  filesystem: two processes, same path, no lock        →  race surface ✗
                                                           (mitigated by naming)
```

Answer: "No in-memory races — run-to-completion makes sync mutation atomic, and each run owns its own state. But the hazard relocates to the filesystem: two writers to the same path are last-write-wins with no lock. AptKit mitigates by embedding timestamps in filenames rather than locking, which fits the low-contention append pattern." Anchor: `run-agent-loop.ts:94–95`, `vite.config.ts:1356–1360`. The part people forget: single-threaded kills *in-memory* races, not *I/O-boundary* races.

**Q: "Where would a race appear if someone added a feature?"** A module-level mutable cache shared across requests (e.g. memoizing tool results in a top-level `Map`) — mutating it across an `await` reintroduces the read-stale-write race. Currently no such cache exists.

## Validate

1. **Reconstruct:** Write the classic single-threaded read-await-write race in pseudocode, then explain why AptKit's per-run arrays can't hit it.
2. **Explain:** Why is `FixtureModelProvider.index++` safe despite being mutable? (Per-run instance, single owner — `fixture-provider.ts:13`, constructed fresh at `vite.config.ts:756`.)
3. **Apply:** Two Studio tabs promote the same artifact in the same second. What happens? (Same path → last-write-wins, no error; `vite.config.ts:1359`.)
4. **Defend:** Argue why no mutex is needed, and name the one change that would require introducing synchronization.

## See also

- `02-processes-threads-and-tasks.md` — the single-thread guarantee that kills in-memory races.
- `06-filesystem-streams-and-resource-lifecycle.md` — the filesystem write paths in depth.
- `.aipe/study-distributed-systems/` *(when generated)* — the fallback chain as partial-failure coordination across providers.
