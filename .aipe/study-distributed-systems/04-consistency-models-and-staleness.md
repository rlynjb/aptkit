# 04 — Consistency models and staleness

**Industry name(s):** consistency models / CAP / strong vs eventual consistency
/ read-your-writes / staleness. **Type:** Industry standard.
**Status in AptKit:** ~ weak analog (the re-sent message history) + mostly
`not yet exercised`.

## Zoom out, then zoom in

Consistency is about *agreement between copies of data.* AptKit has almost
nothing here because it has almost no replicated state — there's one copy of
everything, in one process. The honest mapping: the only "shared state" between
your process and the provider is the conversation history, and AptKit keeps it
consistent the brute-force way — by re-sending the whole thing every turn.

```
  Zoom out — where consistency would live (mostly empty here)

  ┌─ Service layer (one copy of all state, in memory) ───────────┐
  │  messages[] ── the conversation history (re-sent each turn)   │ ← the only analog
  └─────────────────────────────┬────────────────────────────────┘
                               │ complete() re-sends full messages[]
  ┌─ Provider boundary ─────────▼────────────────────────────────┐
  │  provider holds NO state between calls (stateless per call)    │
  └───────────────────────────────────────────────────────────────┘

  no replicas · no cache · no DB → no staleness, no read-your-writes problem
```

Zoom in: a **consistency model** is the contract for what a read can observe
relative to recent writes. *Strong* (linearizable): a read always sees the
latest write. *Eventual*: reads may see stale data, but copies converge if
writes stop. *Read-your-writes*: you at least see your *own* recent writes.
AptKit is trivially strongly consistent because there's only one copy of each
datum — there's nothing to be stale relative to.

## Structure pass — layers, axis, seam

Trace the **state axis** — "where does this datum live, and is there more than
one copy?":

```
  "how many copies of this datum exist?" — down the layers

  ┌────────────────────────────────────────────┐
  │ in-memory state (messages, toolCalls, trace)│ → ONE copy. trivially consistent.
  └────────────────────┬───────────────────────┘
      ┌────────────────▼─────────────────────────┐
      │ filesystem artifacts (artifacts/replays/) │ → ONE copy, written once,
      │                                            │   read-only after. no convergence
      └────────────────┬───────────────────────────┘
          ┌────────────▼─────────────────────────┐
          │ provider conversation state           │ → ZERO copies held remotely;
          │                                       │   re-sent each turn (stateless)
          └───────────────────────────────────────┘
```

There's no seam where copies diverge, because there are no copies. The axis
never flips — that's the finding. The provider being stateless-per-call (you
re-send `messages` every turn) is what *eliminates* the consistency problem at
the boundary.

## How it works

### Move 1 — the mental model: CAP, and why AptKit doesn't pay its tax

You know the shape from a cache: the cache and the database are two copies of the
same data, and they can disagree (stale cache). CAP says: when the network
*partitions* (the two copies can't talk), you must choose — stay **C**onsistent
(refuse reads/writes until they reconnect) or stay **A**vailable (serve possibly
stale data). You can't have both during a partition.

```
  CAP — the forced choice during a partition (general)

  network partition splits the copies:
       copy A ──╳── copy B   (can't sync)

       choose C: refuse to serve → consistent but unavailable
       choose A: serve anyway    → available but possibly stale

  AptKit pays NO CAP tax: one copy → no partition between copies → no choice
```

AptKit never faces this choice because it never has two copies of the same datum
to keep in sync. CAP is a tax on *replication*; with no replication, the bill is
zero.

### Move 2 — the one analog, and the absences

**The analog: re-sending history as "consistency by resend."** The provider
holds no memory of your conversation between `complete()` calls. So how does turn
3 know about turn 1? You re-send the entire `messages` array every turn. There's
no risk of the provider's copy going stale relative to yours because the provider
*has no copy* — it gets a fresh, complete snapshot each call.

```
  Consistency by resend — the stateless-per-call trick

  turn 1: complete([m0])             provider sees: [m0]
  turn 2: complete([m0, m1, r1])     provider sees: [m0, m1, r1]   ← full resend
  turn 3: complete([m0, m1, r1, ...]) provider sees: everything    ← never stale

  cost: bandwidth grows each turn. benefit: zero consistency bugs.
```

This is a real (if humble) distributed-systems choice: trade bandwidth for the
total elimination of distributed state. It's why there's no session affinity, no
sticky routing, no "did the provider remember my context" problem.

**The one real durability seam (new): memory's injected store.** `@aptkit/memory`
is the first place a piece of state's *durability* is a choice rather than a
constant. The same `remember`/`recall` logic
(`packages/memory/src/conversation-memory.ts:73-107`) runs over an ephemeral
`InMemoryVectorStore` (dies on exit) or a durable `PgVectorStore` (survives
restarts, in `buffr`). With the ephemeral store the consistency story is
unchanged — one copy, dies with the process. With the *durable* store, a new
hazard appears that isn't a stale-read problem but an **id-collision** one:

```
  The counter-vs-durable-store mismatch (inference)

  in-process counter Map      durable store (PgVectorStore, in buffr)
  (resets to 0 on restart)     (rows for convId 'c1' already persisted)
        │                              │
  restart →  counter['c1'] = 0         rows: memory:c1:0, memory:c1:1 exist
        │                              │
  resume 'c1', remember() ──► id = memory:c1:0  ──► UPSERT collides → overwrites
                                                      the original turn 0 silently
```

The counter (`conversation-memory.ts:71,78-79`) is **ephemeral state assuming a
single, never-restarted process**: ids are unique only because one in-process
`Map` hands them out monotonically. Resume the same conversation against a store
that *remembers* the old rows and the id-generation invariant breaks — the new
turn 0 overwrites the persisted turn 0. **This is an inference, not an observed
bug: aptkit only ever wires the in-memory store, where counter and rows die
together, so the mismatch can't occur here. It becomes real only in `buffr`, the
moment a durable store is paired with a resumable conversationId across a
restart.** The fix is to derive `n` from the store (count existing rows for the
conversation) or use a content/uuid id instead of an in-process counter — see
`09` R7.

**The absences (`not yet exercised`):**

- **Stale reads / eventual consistency:** none. *Trigger: a read replica or a
  cache in front of any data source.*
- **Read-your-writes:** none. *Trigger: writing to a primary and reading from a
  replica that lags.*
- **Convergence (CRDTs, anti-entropy):** none. *Trigger: two writable copies of
  the same state (e.g. offline-first sync — which Rein's `buffr`/`dryrun`
  projects exercise, but AptKit does not).*

### Move 3 — the principle

**Consistency is a tax on replication; if you don't replicate, you don't pay
it.** The strongest consistency guarantee is the one you get for free by having a
single copy. AptKit's design — one process, one copy, stateless provider calls —
is the cheapest possible consistency story, and it's correct precisely because
the workload doesn't need replication.

## Primary diagram

```
  Consistency landscape — AptKit's position

  STRONG ──────────────────────────────────────── EVENTUAL
   one copy                                       many copies,
   always current                                 converge later
      ▲                                                ▲
      │                                                │
   AptKit lives HERE                            not yet exercised
   (single copy of all state;                  (trigger: any replica,
    provider stateless per call)                cache, or 2nd writer)
```

## Implementation in codebase

**Use cases.** Every multi-turn agent run re-sends history; the consistency
"mechanism" is just the loop pushing onto `messages` and passing the full array.

**Consistency by resend, in the loop.**

```
  packages/runtime/src/run-agent-loop.ts  (lines 94, 124, 189, 103-109)

  const messages = [{ role: 'user', content: userPrompt }];  ← the single copy of state
  ...
  messages.push({ role: 'assistant', content: response.content });  ← append turn result
  ...
  messages.push({ role: 'user', content: toolResults });            ← append tool results
  ...
  const response = await model.complete({ system, messages, ... }); ← re-send the WHOLE array
       │
       └─ the provider gets the complete history every call. there's no remote
          session to go stale — the full state ships on every request. that's the
          entire consistency story, and it's why there are zero staleness bugs.
```

**`not yet exercised`:** no cache, no replica, no second datastore anywhere in
the repo. Artifacts under `artifacts/replays/` are write-once / read-only — they
never need convergence.

## Elaborate

CAP (Brewer's conjecture, proven by Gilbert & Lynch) is the most-cited and
most-misused result in the field. The nuance worth knowing: it only forces a
choice *during a partition* — when the network is healthy, you can have both C
and A. The PACELC extension adds: even without a partition (Else), you trade
Latency vs Consistency. AptKit escapes both because it has no replicas to
partition and no replica reads to slow down. Rein's offline-first projects
(`buffr`'s SQLite-primary-with-Supabase-mirror, `dryrun`'s GitHub-as-backend)
are where she's actually *touched* convergence — AptKit deliberately doesn't.

## Interview defense

**Q: "What's your consistency model?"**

"Single-copy strong consistency, for free — there's exactly one copy of every
datum, in one process. The provider is stateless per call; we re-send the full
conversation history every turn, so there's no remote session to go stale. We
pay no CAP tax because we don't replicate."

```
  one copy → no partition between copies → no C-vs-A choice → strong, free
```

**Q: "When would you need eventual consistency here?"**

"The moment a second copy of any state appears — a read replica, a cache, an
offline client. None exist today. If I added a hosted artifact store with a read
replica, I'd inherit read-your-writes as a real concern. That's the trigger."

## Validate

1. **Reconstruct:** State the CAP choice and explain why AptKit never has to make
   it.
2. **Explain:** How does turn 3 of an agent run "know" about turn 1 when the
   provider holds no state? Cite the mechanism (`run-agent-loop.ts:94,124,189`).
3. **Apply:** You add a Redis cache for `WorkspaceDescriptor` lookups. Which
   consistency problem appears, and what's the cheapest acceptable model?
4. **Defend:** Argue that "consistency by resend" is the right call here, naming
   the cost it pays (`run-agent-loop.ts:103-109`).
5. **Apply (new):** `@aptkit/memory`'s id counter resets on restart
   (`conversation-memory.ts:71`). Explain why that's harmless with the in-memory
   store but an id-collision hazard once a durable `PgVectorStore` resumes the
   same conversation post-restart. What's the cheapest fix?

## See also

- `01-distributed-system-map.md` — state ownership across the map.
- `05-replication-partitioning-and-quorums.md` — what you'd add to get multiple
  copies (and the consistency cost that follows).
- `study-database-systems` — datastore-local consistency (AptKit has none).
