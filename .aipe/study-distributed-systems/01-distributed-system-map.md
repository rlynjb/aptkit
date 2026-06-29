# 01 — The Distributed System Map

**Industry names:** system topology · failure domains · service boundary map · trust/ownership map — *Industry standard.*

## Zoom out, then zoom in

Before any mechanism, look at where coordination actually happens. aptkit *looks*
like one process, and most of it is. The distributed-systems content lives only at
the boundaries where one process talks to another over a network it doesn't own.

```
  Zoom out — the four bands, and where boundaries cross them

  ┌─ App layer (single Node process) ──────────────────────────────────┐
  │   runAgentLoop · RagQueryAgent · ToolRegistry                       │
  │   ★ everything here is in-process: no coordination ★                │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │  ModelProvider.complete() / EmbeddingProvider.embed()
  ┌─ Provider / adapter layer ▼─────────────────────────────────────────┐
  │   FallbackModelProvider · ContextWindowGuardedProvider              │
  │   GemmaModelProvider · OllamaEmbeddingProvider                      │
  │   ★ THE SEAM: in-process call on the near side,                     │
  │     network call on the far side ★                                  │ ← we are here
  └───────────────────────────┬─────────────────────────────────────────┘
                              │  HTTP :11434          │  TCP (pg)
  ┌─ External services ───────▼───────────────────────▼─────────────────┐
  │   Ollama daemon (separate process)   Supabase Postgres (network DB) │
  │   ★ partial failure originates here ★                               │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: a **system map** answers one question — *which boxes can fail
independently of which other boxes?* A box that can crash, hang, or fall off the
network without taking its caller down with it is a **failure domain.** Drawing
those domains, and the boundaries between them, is the first move before you reason
about anything else. You can't reason about partial failure until you know which
parts can fail *partially*.

## Structure pass

**Layers.** Three nested levels: (1) the in-process app, (2) the provider adapters
that sit on the seam, (3) the external services across the network.

**Axis — trace `failure origin` down the layers.** Hold one question constant:
*where does a failure start, and what contains it?*

```
  One axis — "where does failure originate / get contained?" — top to bottom

  ┌─ App layer ───────────────────────────────┐
  │  failure = a thrown error from complete()  │  → caught by runAgentLoop's
  │                                            │    try/catch around the tool call
  └─────────────────────┬──────────────────────┘
       ┌────────────────▼───────────────────────┐
       │ Provider layer: FallbackModelProvider   │  → CONTAINS failure: catches,
       │                                         │    records attempt, tries next
       └────────────────┬───────────────────────┘
            ┌───────────▼────────────────────────┐
            │ External: Ollama / Postgres         │  → ORIGINATES failure: HTTP
            │                                     │    non-200, ECONNREFUSED, hang
            └─────────────────────────────────────┘

  the answer flips at each altitude — that flip is where the contracts live
```

**Seams (boundaries where the axis-answer flips).** The flip from "originates" to
"contains" happens at the provider adapter. That's the load-bearing seam: the
near side is a normal in-process method call (`provider.complete(request)`); the
far side is a network round-trip that can fail in ways an in-process call never
does (it can *hang*, it can return *stale* data, it can *partially* apply a write).
Every distributed-systems lesson in this repo hangs off one of these four seams.

## How it works

### Move 1 — the mental model: a process can only see messages, never state

The single hardest thing about a boundary: your process never sees the other side's
*state*. It only sees the *messages* that come back — or the silence when none do.
A successful `fetch()` is a message. An `ECONNREFUSED` is a message. But a `fetch()`
that hasn't returned yet is **ambiguous** — the daemon might be working, might be
wedged, might be dead. You cannot tell from inside your process. That ambiguity is
the entire problem.

```
  The boundary — you see messages, never the far side's state

  near side (your process)        boundary         far side (you can't see in)
  ┌────────────────────┐                           ┌──────────────────────┐
  │ provider.complete()│ ──── request message ───► │  Ollama: working?    │
  │                     │                           │          wedged?      │
  │   awaiting...       │ ◄─── response message ─── │          crashed?     │
  │   (ambiguous!)      │      ...or silence        │  YOU CANNOT TELL      │
  └────────────────────┘                           └──────────────────────┘
              ▲
              └─ the gap between "sent" and "received" is where
                 every distributed-systems bug lives
```

### Move 2 — walking the four seams

**Seam 1 — the app↔Ollama HTTP boundary.** This is the one you cross most. The
default transport is a bare `fetch`:

```ts
// packages/providers/gemma/src/gemma-provider.ts:201-215
function defaultHttpTransport(host: string): GemmaChatTransport {
  const base = host.replace(/\/$/, '');
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/chat`, {       // ← network round-trip
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),                    // ← only cancellation, no deadline
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status}: ...`); // ← failure becomes a thrown error
    }
    return (await res.json()) as OllamaChatResponse;
  };
}
```

The annotation that matters: the `signal` is *caller-driven cancellation*, not a
*timeout*. Nothing in this function gives up on its own. The embedding provider is
the same shape (`ollama-embedding-provider.ts:60-75`). This is failure domain #1 —
Ollama is a separate OS process that can die or hang without your process knowing.

**Seam 2 — the fallback chain (a failure-containment boundary).** This is the one
adapter whose entire job is to *contain* a far-side failure:

```ts
// packages/providers/fallback/src/fallback-provider.ts:50-64
for (let index = 0; index < this.providers.length; index += 1) {
  const provider = this.providers[index];
  request.signal?.throwIfAborted();
  try {
    const response = await provider.complete(request);  // ← may be the network call
    this.lastSelectedProvider = { providerId: provider.id, ... };
    return { ...response, model: response.model ?? provider.defaultModel };
  } catch (error) {
    // ← failure CONTAINED here: recorded, then we fall through to the next provider
  }
}
```

This is the seam where the axis flips from "originates" to "contains." Notice what
it *can't* contain: a provider that hangs forever never reaches the `catch`, so the
loop never advances. Containment depends on the far side actually *failing* rather
than stalling — which is exactly why finding #1 (no timeout) undermines this seam.

**Seam 3 — buffr↔Postgres (a network database).** buffr opens a `pg.Pool`
(`buffr/db.ts:4-6`) and every `PgVectorStore` query crosses it. A pool is itself a
small distributed-systems object: a bounded set of TCP connections shared across
concurrent callers. Run out of connections and callers *queue*; the DB goes away
and every checked-out connection errors. → walked in
`05-replication-partitioning-and-quorums.md` and `09`.

**Seam 4 — the trace as an event log.** The `CapabilityEvent` union
(`runtime/events.ts:1-24`) is an append-only log emitted as the agent runs. In
aptkit it's streamed as NDJSON; in buffr it's drained into `agents.messages`. An
event log that has to survive racing writers and reconstruct order is a
distributed-systems artifact even inside one process — walked in `06` and `07`.

### Move 3 — the principle

A "distributed system" is not defined by how many machines you have. It's defined
by how many **independent failure domains** a single operation depends on. The
instant your operation's success depends on a box that can fail without telling
you, you're doing distributed systems — even if both boxes are on your laptop. Map
the failure domains first; the mechanisms are all answers to "what happens when
domain X is slow, dead, or racing?"

## Primary diagram

The full map, with every boundary and failure domain labelled.

```
  aptkit + buffr — failure domains and the boundaries between them

  ┌─ FAILURE DOMAIN A: aptkit process ────────────────────────────────────┐
  │  runAgentLoop ──► provider.complete() ──► [adapters: fallback, guard]  │
  │  emit(CapabilityEvent) ─────────────► trace (NDJSON stream)            │
  └───────────────┬─────────────────────────────────┬──────────────────────┘
                  │ HTTP :11434 (no timeout)         │  (aptkit core also consumed
                  ▼                                  │   by buffr as a library)
  ┌─ FAILURE DOMAIN B: Ollama daemon ──┐             │
  │  /api/chat   (Gemma)               │             │
  │  /api/embed  (nomic-embed-text)    │             │
  └────────────────────────────────────┘             │
                                                      ▼
  ┌─ FAILURE DOMAIN C: buffr process ─────────────────────────────────────┐
  │  ChatSession.ask() ──► PgVectorStore ──► pg.Pool ──┐                    │
  │                   └──► SupabaseTraceSink.flush() ──┤                    │
  └────────────────────────────────────────────────────┼───────────────────┘
                                                        │ TCP (pg)
  ┌─ FAILURE DOMAIN D: Supabase Postgres ────────────────▼─────────────────┐
  │  agents.documents · agents.chunks (pgvector) · conversations · messages│
  └─────────────────────────────────────────────────────────────────────────┘

  A operation can depend on A→B (every model call) and C→B + C→D (every buffr turn).
  Each arrow is a place the operation can hang, fail, or partially apply.
```

## Elaborate

The "failure domain" framing comes from large-scale systems work where the
question is never "is the system up?" but "*which parts* are up, and what's still
correct given the parts that aren't?" The classic reference is the *fallacies of
distributed computing* (the network is reliable, latency is zero, bandwidth is
infinite...). aptkit violates the first fallacy at exactly two arrows: the Ollama
HTTP call and the pg TCP connection. Everything else is in-process and immune.

What makes this repo a *good* place to learn the subject rather than a frustrating
one: the failure domains are few and concrete. You can hold all four in your head.
At Google scale the map has thousands of boxes and you reason statistically; here
you reason exactly, which is the right place to build the intuition first.

## Interview defense

**Q: "Is this a distributed system?"**
Answer with the verdict, not a dodge: "It's a single-process app with two real
network boundaries — Ollama over HTTP and Supabase Postgres over TCP. So the
*distributed-systems surface* is exactly those two arrows plus the fallback chain
that sits on them. Everything else is in-process and has no partial-failure
semantics. I'd rather name the two real seams precisely than claim a cluster I
didn't build."

```
  the one-line map you sketch while answering

  [aptkit] ──HTTP──► [Ollama]        ← seam 1: can hang (no timeout)
  [buffr]  ──TCP───► [Postgres]      ← seam 3: pool, transactions, racing writes
       └─ fallback chain wraps seam 1 ← seam 2: contains failure
```

**Q: "What's a failure domain and why map it first?"**
"A failure domain is a box that can fail independently of its caller. I map them
first because partial failure — the whole subject — is only meaningful between
domains. Inside one process a function either runs or the process dies; across a
domain boundary the callee can hang, return stale data, or partially apply a write
while the caller keeps running. The map tells me which arrows need timeouts,
retries, and idempotency, and which don't need anything because they never leave
the process."

*Anchor:* four failure domains, two network arrows, `fallback-provider.ts:50-64`
is the one that contains failure.

## See also

- `02-partial-failure-timeouts-and-retries.md` — what to do at each boundary arrow
- `09-distributed-systems-red-flags-audit.md` — ranked risks per seam
- **study-networking** — the wire-level mechanics of the two network arrows
- **study-system-design** — why these boundaries exist (local-first, single DB)
```
