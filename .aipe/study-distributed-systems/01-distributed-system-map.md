# 01 — The distributed system map

**Industry name(s):** system topology / failure-domain map / coordination map.
**Type:** Industry standard (concept) · Project-specific (the map).

## Zoom out, then zoom in

Before any mechanism, here's the whole thing in one frame. The question a
distributed-systems map answers is: *what are the nodes, where are the
boundaries, who owns what, and where can a failure be contained?* For most
systems that's a busy diagram. For AptKit it's almost embarrassingly small —
and that smallness is the single most important fact about this repo.

```
  Zoom out — where "the system" actually lives

  ┌─ UI layer (local dev only) ─────────────────────────────────┐
  │  apps/studio — React + Vite, replay API over NDJSON          │
  └───────────────────────────┬──────────────────────────────────┘
                              │ in-process function calls
  ┌─ Service layer (ONE Node process) ──▼───────────────────────┐
  │  runAgentLoop → tools → parseAgentJson → usage-ledger        │
  │  RagQueryAgent → retrieval pipeline (embed → search)         │
  │  ★ THIS FILE: the map of these boxes and their exits ★       │ ← we are here
  └──────────────┬────────────────────────────────┬──────────────┘
                 │ ModelProvider.complete()        │ EmbeddingProvider.embed()
  ┌─ Provider boundary ─▼──────────────────────────▼──────────────┐
  │  Anthropic / OpenAI / Fallback / ContextGuard / Gemma adapters │
  └──────────────┬────────────────────────────────┬──────────────┘
                 │ HTTPS                            │ HTTP (localhost)
                 ▼                                  ▼
  ┌─ External: cloud (not yours) ─────┐  ┌─ External: local Ollama process ──┐
  │  api.anthropic.com  api.openai.com │  │  :11434  /api/chat  /api/embed     │
  └────────────────────────────────────┘  └────────────────────────────────────┘
```

Zoom in: a "node" is an independent failure unit — something that can crash,
slow, or lie *without* taking its neighbors down with it. By that definition
AptKit now has **three**: your process, the cloud provider API, and the local
Ollama process. The third one is the subtle addition — Ollama runs on the *same
machine* over plain HTTP, so it feels like a local call, but it's a **separate
OS process** you talk to over a socket. It can be not-running, mid-model-load,
or slow, independently of your process. That makes it a node, not a function
call. The Studio UI, by contrast, is *not* a separate node — it calls into the
same process via Vite middleware. So the map is three boxes and (up to) two
arrows out of your process, and the whole discipline is about what happens to
those arrows.

## Structure pass — layers, axis, seam

Three layers (UI / Service / Provider), and we trace **one axis: failure — where
does it originate, propagate, and get contained?** Hold that question constant
and walk down.

```
  One question down the layers: "where does failure get contained?"

  ┌────────────────────────────────────────────┐
  │ UI layer (Studio)                           │  → failure = render error,
  │                                             │    local, no blast radius
  └────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ Service layer (agent loop, tools, parse)  │  → failure = throws in-process,
      │                                           │    caught by try/catch, bounded
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ Provider boundary (the HTTPS hop)     │  → failure = ORIGINATES HERE:
          │                                       │    timeout, 429, 5xx, partial
          └──────────────────────────────────────┘

  the answer flips at the boundary — that flip IS the seam
```

The **seam** is the `ModelProvider.complete()` contract. It's load-bearing
because the failure axis *flips* across it: above the seam, failures are
ordinary in-process exceptions you can reason about with a stack trace. Below
it, failures are partial and ambiguous — a timeout could mean the request never
arrived, arrived but the response was lost, or fully succeeded on the
provider's side while your socket died. That ambiguity is the entire reason
distributed systems are hard, and it lives at exactly one place in this repo.

The other seam worth naming is **trust**: everything above the boundary is code
you wrote and can change; everything below is a system run by someone else,
with their own rate limits, deploys, and outages (fallacy #6 — "there is one
administrator" — is false, and the administrator isn't you).

## How it works

### Move 1 — the mental model: nodes and the edges between them

A distributed system map is a graph: nodes are failure units, edges are the
messages between them. You already build this shape constantly — a React app
calling a `fetch()` to a backend is a two-node graph. AptKit is the same shape,
with a fork: your process is node A, and it talks to *either* a cloud provider
API *or* the local Ollama process — each its own node — over `complete()` /
`embed()`.

```
  The map as a graph — node = failure unit, edge = message

                              complete()  ┌──────────────────┐
         ┌─────────────────┐ ───────────► │  Cloud API (B)   │  someone else owns
         │  AptKit process │ ◄─────────── └──────────────────┘  (HTTPS, rate-limited)
         │  (node A)       │
         │  you own this   │  complete() / embed()  ┌──────────────────┐
         └─────────────────┘ ─────────────────────► │  Ollama proc (C) │  you run it, but
                             ◄───────────────────── └──────────────────┘  it's a separate
                                                                          process (localhost)
  two edges out of A. that's the system.
```

The thing that makes it a *distributed* map rather than plain function calls:
B and C can each fail independently of node A. Node A keeps running while a
provider is down. There's no shared memory, no shared clock, no transaction
spanning the boundary — and crucially, that's true for the *localhost* hop too.
Ollama sharing your machine doesn't make it share your address space; a crashed
or not-yet-started Ollama is a partial failure exactly like a cloud 503.

### Move 2 — walking the map

**The failure domains.** A failure domain is the set of things that go down
together. In AptKit there are now three, cleanly separated:

```
  Failure domains — what dies together

  ┌─ Domain 1: your process ──────────┐   ┌─ Domain 2: cloud provider ─────┐
  │  agent loop, tools, parsing,      │   │  api.anthropic.com / openai     │
  │  ledger, retrieval, Studio        │   │  dies → complete() throws (503),│
  │  dies → nothing remote affected   │   │  loop falls over to fallback    │
  └───────────────────────────────────┘   └─────────────────────────────────┘
                                          ┌─ Domain 3: local Ollama proc ──┐
                                          │  :11434, gemma + nomic models   │
                                          │  not running / loading / slow → │
                                          │  fetch rejects → same throw path │
                                          └─────────────────────────────────┘
```

When domain 2 *or* 3 fails, domain 1 stays up and *handles* it — that's the
whole point of the fallback chain (a down Ollama can fail over to cloud, and
vice versa). When domain 1 fails (your process crashes), there's nothing to
coordinate; you just restart and re-run. No partial state is stranded in a
remote system because there's no remote state in this design — the in-memory
`InMemoryVectorStore` dies with domain 1 and is rebuilt on the next run by
re-indexing the corpus.

**Ownership.** Every piece of state in AptKit is owned by domain 1 and lives in
memory or on the local filesystem: the `messages` array in the loop, the
`toolCalls` records, the trace events, the replay artifacts in
`artifacts/replays/`, and the embedded chunks in `InMemoryVectorStore`. The
providers own *nothing* of yours between calls — each `complete()`/`embed()` is
stateless from your side; you re-send the full message history every turn and
re-send the text to embed every call. Ollama holds the loaded model weights, but
no per-request state of yours. That stateless-per-call design is why there's no
consistency problem to solve (covered in `04`).

**The messages.** A small, fixed set crosses the boundaries: a `ModelRequest`
out → `ModelResponse` back on the chat edge, and `string[]` (texts) out →
`number[][]` (vectors) back on the embed edge. Either can fail or never return.
There's no gossip protocol, no heartbeat, no replication stream. The richness
lives *inside* domain 1 as `CapabilityEvent`s on a trace, never on the wire.

### Move 3 — the principle

The most senior thing you can say about a system is **"here's the smallest
true map of it."** For AptKit that map is your process plus its external-service
dependencies — three nodes, two edge *types*, all behind one provider contract.
Drawing it honestly — counting the localhost Ollama process as a real node
rather than waving it away as "local" — is the skill. A system whose distributed
surface is external-service calls needs the discipline of *those edges* and
nothing more; bolting on consensus or queues would be complexity with no failure
to justify it.

## Primary diagram

The full recap — every layer, the three nodes, the two edge types, and where
failure is contained.

```
  AptKit — the complete distributed map

  ┌─ UI (local) ──────────────────────────────────────────────────┐
  │  apps/studio  ── in-process calls, NOT a remote node            │
  └────────────────────────────┬───────────────────────────────────┘
                              │ function call (same process)
  ┌─ Service (NODE A — your process, failure domain 1) ─▼──────────┐
  │  runAgentLoop ─ tools ─ parseAgentJson ─ usage-ledger ─ trace   │
  │  RagQueryAgent ─ retrieval pipeline ─ InMemoryVectorStore       │
  │  state lives HERE: messages[], toolCalls[], events[], vectors[] │
  └──────────────┬────────────────────────────────┬────────────────┘
        complete()│  ← THE SEAM (failure axis flips) │ embed()
  ┌─ Provider adapters (still NODE A) ─▼────────────▼──────────────┐
  │  Anthropic · OpenAI · Fallback · ContextGuard · Gemma · Ollama  │
  └──────────────┬────────────────────────────────┬────────────────┘
        HTTPS     │  ◄── node-to-node edges ──►    │ HTTP (localhost)
  ┌─ Cloud (NODE B, domain 2) ─▼──────┐  ┌─ Ollama (NODE C, domain 3) ─▼──────┐
  │  api.anthropic.com  api.openai.com │  │  :11434  /api/chat  /api/embed      │
  │  partial failure originates here   │  │  partial failure originates here too │
  └────────────────────────────────────┘  └──────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every agent run instantiates this map. A recommendation run
builds a `WorkspaceDescriptor`, assembles a prompt, enters `runAgentLoop`, and
the only thing that leaves your process is the `complete()` call to a provider.
The map is the same for monitoring, diagnostic, query, and rubric agents — they
differ in prompt and tool policy, not topology. The **RAG query agent**
(`packages/agents/rag-query/scripts/ask.ts`) is the richest instance: it crosses
the boundary *twice* per question against Ollama — once via
`OllamaEmbeddingProvider.embed()` to vectorize the query, once via
`GemmaModelProvider.complete()` to reason over the retrieved chunks — plus the
embed calls at index time. Both depend on the same external process being up.

**The seam — the contract that defines the boundary.**

```
  packages/runtime/src/model-provider.ts  (the ModelProvider contract)
  packages/runtime/src/run-agent-loop.ts  (lines 103-109)

  const response = await model.complete({   ← the ONE call that crosses node A→B
    system: ...,                            ← everything assembled in-process
    messages,                               ← full history re-sent each turn
    tools: forceFinal ? undefined : ...,    ← (stateless from your side)
    maxTokens,
    signal,                                 ← cancellation rides along the edge
  });
       │
       └─ this await is the entire distributed surface. Above it: in-process.
          Below it: a network you don't control. Everything else in the repo
          is one side or the other of this single line.
```

**The three real nodes, in code:**

- Node A (your process): `packages/runtime/src/run-agent-loop.ts:76-202` — the
  loop and all the state it owns (`messages`, `toolCalls`, `finalText`).
- Node B (cloud provider): reached only through an adapter, e.g.
  `packages/providers/anthropic/src/anthropic-provider.ts:28-61`, the thinnest
  possible translation over `client.messages.create(...)`.
- Node C (local Ollama process): reached through two adapters that both default
  to `fetch` against `http://localhost:11434` —
  `packages/providers/gemma/src/gemma-provider.ts:201-215` (`/api/chat`) and
  `packages/retrieval/src/ollama-embedding-provider.ts:60-75` (`/api/embed`).
  Both throw `ollama HTTP <status>` on a non-OK response, or reject when the
  process isn't running.

**What's NOT on the map (and the trigger that would add it):**

- No second process *of yours*, no IPC, no RPC between your own components →
  *trigger: extracting the agent loop into its own service that Studio calls
  over HTTP.* (Ollama is a node, but it's not *your* component — it's a
  dependency.)
- No *durable* datastore node → *trigger: swapping `InMemoryVectorStore` for the
  planned `PgVectorStore` against a hosted Postgres — that adds a fourth node
  with real persistence and its own partial-failure surface. This is deferred to
  the `buffr` repo (`docs/personal-agent-packages.md:81-86`).*
- No queue/broker node → *trigger: making agent runs async with a producer and
  a separate consumer.*

## Elaborate

The discipline of drawing the smallest true map comes from the fact that every
node and edge you add is a new failure mode you now own. Lamport's framing — "a
distributed system is one where the failure of a computer you didn't even know
existed can render your own computer unusable" — is the warning. AptKit dodges
it by having exactly one computer it depends on, and that one is explicit,
named, and handled at the seam.

The neighboring guides open the boxes this map keeps closed:
`study-networking` opens the HTTPS edge (what actually happens on the wire when
`complete()` runs); `study-system-design` treats the adapter layer as an
architectural decision (provider-neutral core, swappable adapters); this guide
only cares that the edge can fail and what node A does about it.

## Interview defense

**Q: "Walk me through your system's architecture and where it's distributed."**

Draw the three-node graph. Say: "It's single-process by design — a library plus
a local dev tool. Its distributed surface is external-service dependencies: cloud
model APIs over HTTPS, and a local Ollama process over HTTP for the Gemma/RAG
path. Everything else is in-process function calls — and it is *not* a
distributed system itself; the multi-node sync plane is deferred to a separate
repo."

```
  [your process] ──complete()──► [cloud API]      owns nothing of yours
   owns all state  ──embed()────► [Ollama proc]    separate process, localhost
   failure domain 1               domains 2 and 3
```

Anchor: "The seam is the `ModelProvider`/`EmbeddingProvider` contract — that's
where the failure axis flips from in-process exceptions to partial network
failure. The non-obvious part: the Ollama hop is on localhost but it's still a
separate failure domain, because it's a separate process."

**Q: "Why not add a queue / cache / second service?"**

Model answer: "Nothing in the workload justifies a second node. Adding one adds
a failure domain with no failure to contain. The honest move is to draw the
two-box map and add infrastructure only when a real trigger appears — async
hand-off would justify a queue, a too-big dataset would justify sharding. None
of those exist yet."

## Validate

1. **Reconstruct:** Draw AptKit's full map from memory — how many nodes, how
   many edge types, where's the seam?
2. **Explain:** Why is the local Ollama process *a* node (a separate failure
   domain) while `apps/studio` is *not*, even though Studio has its own API
   routes and Ollama is on the same machine? (Hint: separate OS process vs
   same address space.)
3. **Apply:** A teammate proposes moving artifact storage to a hosted Postgres.
   Redraw the map. What new failure domain appears, and what new partial-failure
   case must the code now handle?
4. **Defend:** Argue that a single-edge map is the *correct* design for this
   repo, not a limitation. (Hint: `run-agent-loop.ts:76-202` owns all state in
   memory — what does that buy you on crash recovery?)

## See also

- `00-overview.md` — the ranked findings and the `not yet exercised` table.
- `02-partial-failure-timeouts-and-retries.md` — what node A does when the edge
  fails.
- `study-networking` — the transport inside the HTTPS edge.
- `study-system-design` — the adapter layer as an architectural decision.
