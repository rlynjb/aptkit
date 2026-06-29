# 01 — The Distributed System Map

**Industry names:** coordination map · failure domains · trust/ownership boundaries · the "fallacies of distributed computing." **Type:** Industry standard.

## Zoom out, then zoom in

Here's the whole thing in one frame. aptkit runs in one process; the moment a call leaves that process you've crossed into distributed-systems territory. There are exactly four crossings, and this guide is built around them.

```
  Zoom out — where the coordination boundaries live

  ┌─ App process (aptkit, in-memory) ──────────────────────────────┐
  │  runAgentLoop → providers → tools → InMemoryVectorStore         │  ← one failure domain:
  │  everything here lives or dies together                         │    process crash = all gone
  └───────┬──────────────────────────────────────────┬─────────────┘
          │ ★ seam 1: HTTP                            │ ★ seam 3+4: TCP/SQL
          ▼                                           ▼
  ┌─ Provider service ──────────┐          ┌─ Network database ──────────────┐
  │  Ollama daemon :11434       │          │  Supabase Postgres + pgvector   │  ← separate
  │  (separate process/host)    │          │  agents.documents / chunks /    │    failure
  │  ★ seam 2 = the chain of    │          │  messages                       │    domains
  │    providers in front of it │          │                                 │
  └─────────────────────────────┘          └─────────────────────────────────┘
```

Zoom in: a **coordination map** is just this — the nodes, the messages between them, who owns which state, and where the *failure domains* split. A failure domain is a blast radius: everything that fails together when one thing fails. Inside the process there's one domain (a crash takes the whole agent loop and the in-memory vector store with it). Cross a seam and you've created a second domain that can fail *independently* — and independent failure is the entire subject of distributed systems.

## Structure pass — layers, one axis, the seams

**Layers** (outer to inner):

```
  Layer                         Lives in
  ────────────────────────────  ──────────────────────────────────
  Orchestration   runAgentLoop  packages/runtime/src/run-agent-loop.ts
  Provider port   ModelProvider  packages/runtime/src/  (the contract)
  Provider adapter  Gemma/Fallback  packages/providers/*/src/
  Transport         HTTP fetch / pg.Pool   (the wire)
  External node     Ollama / Postgres      (separate process)
```

**The one axis to trace: *failure containment* — "when this layer's callee dies, what happens?"** Hold that question still and walk down:

```
  "when the thing below me fails, what do I do?"  — traced downward

  ┌──────────────────────────────────────────────┐
  │ runAgentLoop                                  │  → catches, emits warning, may force a
  │                                               │    final turn (run-agent-loop.ts:216-225)
  └───────────────────────┬───────────────────────┘
        ┌─────────────────▼──────────────────────────┐
        │ FallbackModelProvider                       │  → catches a THROW, records attempt,
        │                                             │    advances to next provider (:64)
        └─────────────────┬──────────────────────────┘
              ┌───────────▼────────────────────────────┐
              │ GemmaProvider (fetch)                   │  → throws on !res.ok; on a HANG,
              │                                         │    never throws → nobody contains it
              └───────────┬────────────────────────────┘
                    ┌─────▼──────────────────────────────┐
                    │ Ollama daemon                       │  → can be down, slow, or wedged
                    └─────────────────────────────────────┘

  the answer flips at the fetch: above it, failure is contained;
  AT the wire, a hang is invisible — that's the load-bearing gap
```

**The seams** (a boundary matters when the axis flips across it):

- **Seam 1 — app ↔ Ollama** (`gemma-provider.ts:201`). Failure containment flips: above the `fetch`, errors are caught and classified; the `fetch` itself contains a *thrown* HTTP error (`!res.ok`) but **not a hang**. No timeout, no `AbortController` of its own.
- **Seam 2 — the failover chain** (`fallback-provider.ts:50`). Control flips: the chain decides *which* provider runs next, but only when the current one *throws*. A provider that hangs never yields control back.
- **Seam 3 — app ↔ Postgres** (`pg-vector-store.ts:40`). State ownership flips: in-memory state is gone on crash; Postgres state is durable and shared across processes. A connection pool (`pg.Pool`) sits on the boundary.
- **Seam 4 — the dual write** (`runtime.ts:11`/`:17`). Atomicity flips: the chunk upsert is one transaction; the doc-then-chunks pair is *two*, with no envelope. → walked in `08`.

## How it works

### Move 1 — the mental model

You already know the shape from a `fetch()` in the browser: your component owns its state, the server owns its state, and the network in between can drop, delay, or duplicate the request. A distributed system is that picture with more boxes. The map names every box, every arrow (message), and — the part people skip — draws the dotted line around each *failure domain*.

```
  The map's kernel — node, message, ownership, failure domain

   ┌───────────┐   message    ┌───────────┐
   │  node A   │ ───────────► │  node B   │
   │  owns: X  │ ◄─────────── │  owns: Y  │
   └───────────┘   reply      └───────────┘
   └── domain 1 ──┘            └── domain 2 ──┘
        ▲                            ▲
        └── can crash without ───────┘
            taking the other down
```

The kernel: **two things own different state, talk over a channel that can fail, and can die independently.** Lose any one element and it stops being a distributed problem — collapse them into one process and you're back to ordinary function calls.

### Move 2 — walking the map

**The nodes and what each owns.** Map ownership before mechanics; a bug is usually "who did I think owned this?"

```
  Node              Owns (authoritative state)        Volatile?
  ────────────────  ─────────────────────────────────  ─────────
  aptkit process    agent-loop state, InMemoryVector-   YES — gone
                    Store, usage ledger                  on crash
  Ollama daemon     loaded model weights, its own        separate
                    request queue                        lifecycle
  Supabase PG       agents.documents / chunks /          durable,
                    messages (the system of record)      shared
```

The in-memory vector store (`packages/retrieval`, `InMemoryVectorStore`) is *not* authoritative — it's a cache/test double. The authoritative copy is buffr's `PgVectorStore` against Postgres. That distinction is the whole reason the `VectorStore` contract exists: same interface, two failure profiles.

**The messages and their direction.** Every arrow on the map is a message that can fail. Label its direction and its failure mode:

```
  Layers-and-hops — one agent turn that searches the KB and persists a trace

  ┌─ App (aptkit) ──────────┐  hop 1: POST /api/chat   ┌─ Provider node ────┐
  │  GemmaProvider.complete  │ ───────────────────────► │  Ollama :11434     │
  │                          │  hop 4: JSON reply  ◄──── │  (may hang here)   │
  └───────────┬──────────────┘                          └────────────────────┘
       hop 2  │ tool_call: search_knowledge_base
              ▼
  ┌─ Storage (buffr → PG) ──┐  hop 3: SELECT … ORDER BY embedding <=> $1  ┌─ Postgres ─┐
  │  PgVectorStore.search    │ ──────────────────────────────────────────► │  pgvector  │
  └───────────┬──────────────┘                                            └────────────┘
       hop 5  │ trace event (NDJSON) → SupabaseTraceSink → INSERT messages
              ▼  (created_at = emit timestamp)  → agents.messages
```

Hop 1 is the dangerous one: it's the only hop with no deadline. Hop 3 lives behind a connection pool that can exhaust. Hop 5 is fire-and-forget-ish — the trace insert failing should not fail the turn (a property `study-debugging-observability` cares about).

**The failure domains.** Draw the blast radius. Inside aptkit, everything shares one — kill the process and the loop, the in-memory store, and the ledger all vanish together; that's *fine* because none of it is authoritative. The two external nodes are separate domains: Ollama can be restarting while Postgres is healthy, or vice versa. The skill is asking, for each piece of state, "if this domain dies mid-operation, what's left half-done?" For the dual write, the answer is "an orphaned document" (→ `08`).

### Move 3 — the principle

The map is the first artifact you draw for *any* system, before any mechanism. Nodes, messages, ownership, failure domains. Most distributed bugs are not exotic — they're "I drew the boundary in the wrong place" or "I forgot this arrow could fail." aptkit has only four arrows that can fail independently; a system at scale has thousands. The discipline is identical, and learning it on four is how you earn the right to reason about thousands.

## Primary diagram

The full map, every node, message, ownership, and failure domain in one frame.

```
  aptkit + buffr — the complete coordination map

  ╔═ Failure domain: APP PROCESS (volatile) ════════════════════════════════╗
  ║  ┌────────────────────────────────────────────────────────────────────┐ ║
  ║  │ runAgentLoop (maxTurns=8)  — orchestration, contains caught errors  │ ║
  ║  └───┬───────────────────────────────────────────────┬─────────────────┘ ║
  ║      │ ModelProvider.complete()                       │ tool: search_kb   ║
  ║  ┌───▼─────────────────────────┐               ┌──────▼─────────────────┐ ║
  ║  │ FallbackModelProvider (seam2)│               │ RetrievalPipeline       │ ║
  ║  │  advances on THROW only      │               │  (in-mem OR PgVector)   │ ║
  ║  └───┬──────────────────────────┘               └──────┬──────────────────┘ ║
  ║      │ GemmaProvider.complete                          │                   ║
  ╚══════┼═══════════════════════════════════════════════ ┼═══════════════════╝
         │ seam1: HTTP POST /api/chat  (NO TIMEOUT)        │ seam3: pg.Pool / TCP:5432
         ▼                                                 ▼
  ╔═ Domain: OLLAMA ═══════╗        ╔═ Failure domain: SUPABASE POSTGRES (durable) ═══╗
  ║ Ollama daemon :11434   ║        ║  agents.documents ◄┄┄ soft link ┄┄ agents.chunks ║
  ║ down | slow | WEDGED   ║        ║  (no FK — 001_agents_schema.sql:27)              ║
  ╚════════════════════════╝        ║  agents.messages (created_at = emit ts)          ║
                                    ║         ▲ seam4: dual write lands here, non-atomic║
                                    ╚══════════════════════════════════════════════════╝
```

## Elaborate

The framing comes from Peter Deutsch's "Eight Fallacies of Distributed Computing" (Sun, 1994): the network is *not* reliable, latency is *not* zero, bandwidth is *not* infinite, the network is *not* secure, topology *does* change, and so on. Each fallacy maps to a seam here: "the network is reliable" is exactly the assumption the timeout-less Ollama fetch makes. The reason you draw the map first is that every fallacy is a question you can only ask once you've located the boundary it applies to.

The repo is a good *teacher* precisely because it's small. With four seams you can hold the entire map in your head and reason about each failure exhaustively — which is impossible at scale but is how you build the instinct that transfers.

## Interview defense

**Q: "Walk me through where this system can partially fail."**
Sketch the four-seam map. Say: "single process, so most of it is one failure domain — a crash takes the in-memory store and the loop together, and that's acceptable because none of it is authoritative. The authoritative state is Postgres. The independent-failure surface is four boundaries: the Ollama HTTP call, the failover chain in front of it, the Postgres connection, and the dual write. The one I'd fix first is the Ollama call — no timeout, so a hung daemon hangs everything above it."

```
  the answer sketch — four arrows that can fail

  loop → [chain → gemma] ──HTTP, no timeout──► Ollama   ★ fix first
  loop → pipeline ──pool/TCP──► Postgres ──► (doc, then chunks: not atomic)
```

Anchor: *failure domains are blast radii; aptkit has one volatile and one durable, joined by four fallible arrows.*

**Q: "Why call a single-process library a distributed system at all?"**
Because the moment a call crosses to Ollama or Postgres, you have two parties owning different state over a channel that can fail independently — that's the definition, full stop. The honest answer is most of the canon (consensus, quorums) is `not yet exercised`; what *is* exercised is partial failure and idempotency, and those are the ones that actually bite small systems.

Anchor: *distributed ≠ scaled; distributed = independent failure across a boundary.*

## See also

- `02-partial-failure-timeouts-and-retries.md` — seam 1, the missing deadline
- `08-sagas-outbox-and-cross-boundary-workflows.md` — seam 4, the orphaning dual write
- `09-distributed-systems-red-flags-audit.md` — the ranked risk list
- `study-system-design` (`.aipe/study-system-design/`) — the architectural shape of these same boundaries
- `study-networking` — the transport beneath every arrow on this map
