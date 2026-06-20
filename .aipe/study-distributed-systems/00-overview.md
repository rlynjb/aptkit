# 00 — Overview: the external-service edges

## The verdict first

AptKit is a **single-process library + local dev tool.** Run the agent loop and
everything — prompt assembly, tool dispatch, JSON parsing, the usage ledger,
the Studio replay UI — executes inside one Node runtime, on one machine, in one
address space. There is no second node to coordinate with.

The system reaches across boundaries it doesn't control in exactly one *kind* of
place: a call to an **external model/embedding service over HTTP**. That's the
entire distributed-systems surface of this repo. As of the personal-agent
packages (`@aptkit/provider-gemma`, `@aptkit/retrieval`) there are now **two
flavors** of that boundary, and the distinction matters:

- **Cloud APIs** — `api.anthropic.com`, `api.openai.com` over HTTPS. Someone
  else's machine, someone else's rate limits and outages (fallacy #6).
- **A local Ollama process** at `http://localhost:11434` — reached by
  `GemmaModelProvider` (`/api/chat`) and `OllamaEmbeddingProvider` (`/api/embed`).
  Same machine, plain HTTP, no TLS, no auth — but still a **separate process**
  that can be not-running, mid-model-load, or slow, and whose failures surface as
  thrown errors exactly like the cloud's.

That second flavor is the new lesson: an external dependency doesn't have to be
*remote* to be a separate failure domain. "Is Ollama up?" is a coordination
question even though both processes share a laptop.

```
  The whole system, one frame — find the boundaries

  ┌─ Process boundary (your Node runtime, failure domain 1) ─────────────┐
  │                                                                       │
  │  ┌─ Service layer ────────────────────────────────────────────────┐  │
  │  │  runAgentLoop  ── bounded turns, AbortSignal, JSON re-prompt     │  │
  │  │  RagQueryAgent ── retrieval pipeline (embed → search → ground)   │  │
  │  │       │                                                          │  │
  │  │       ▼                                                          │  │
  │  │  ModelProvider.complete()  ◄── the contract everything uses      │  │
  │  │       │                                                          │  │
  │  │   ┌───┴──────┬──────────┬──────────┬───────────┬─────────────┐  │  │
  │  │   ▼          ▼          ▼          ▼           ▼             │  │  │
  │  │  Anthropic  OpenAI   Fallback  ContextGuard  Gemma (Ollama)  │  │  │
  │  │  adapter    adapter  (chain)   (pre-flight)  + Ollama embed   │  │  │
  │  └───┬─────────┬──────────────────────────────────┬────────────┘  │  │
  │      │         │                                   │               │  │
  └──────┼─────────┼───────────────────────────────────┼───────────────┘
         │ HTTPS   │ HTTPS    ★ EXTERNAL-SERVICE EDGES ★ │ HTTP (localhost)
         ▼         ▼                                     ▼
  ┌─ Cloud provider APIs (not yours) ─────────┐  ┌─ Local Ollama (domain 2) ──┐
  │  api.anthropic.com    api.openai.com       │  │  :11434 /api/chat /api/embed│
  │  timeout / 429 / 5xx / partial / garbage   │  │  down / loading / slow      │
  └────────────────────────────────────────────┘  └─────────────────────────────┘
```

Everything to the left of the HTTP/HTTPS arrows is one process. The discipline
this guide teaches applies to those arrows — and they all share the same shape:
a `complete()`/`embed()` call that can throw because something you don't control
misbehaved.

**Not a distributed system itself.** This is still a single-process library with
external-service dependencies — not a multi-node system. The multi-device,
sync, and Supabase plane (laptop↔phone memory sync, a hosted `PgVectorStore`,
the gateway) is explicitly **deferred and out of scope for aptkit** — it lives
in the separate `buffr` repo (see `docs/personal-agent-packages.md:81-86`).
aptkit ships the deployment-agnostic building blocks; the coordinated *body* is
assembled elsewhere.

## Ranked findings — what's actually here

The findings are ranked by how real they are in *this* repo, most-real first.

### 1. The fallback chain is the one true partial-failure pattern (★ real)

`packages/providers/fallback/src/fallback-provider.ts:47-89` — `FallbackModelProvider.complete()`
tries provider adapters **in sequence**; when one throws, it records the
attempt and moves to the next. When all fail, it throws `ProviderFallbackError`
(`:16-24`) carrying every attempt. This is exactly partial-failure handling
against an unreliable external dependency: one node (provider) being down
doesn't take the whole request down — you fail over. The `shouldFallback`
predicate (`:44`, `:73`) classifies errors (retryable vs not), and the
`AbortError` passthrough (`:65`, `:92-95`) makes cancellation win over
failover. **This is the file to read first.** → see `02` and `05`.

### 2. The context-window guard is fail-fast before a doomed remote call (★ real)

`packages/providers/local/src/context-window-guard.ts:57-71` — a pre-flight
check that estimates input tokens and throws `ContextWindowExceededError`
*before* dispatching to the wrapped provider if the request can't fit. This is
the distributed-systems instinct of "validate locally before paying for a
remote round-trip that will definitely fail." → see `02`.

### 3. Ollama is a second external dependency — local, but a separate failure domain (★ real, new)

`packages/providers/gemma/src/gemma-provider.ts:201-215` and
`packages/retrieval/src/ollama-embedding-provider.ts:60-75` — both default to a
`fetch` transport against `http://localhost:11434` and **throw on a non-OK
response** (`throw new Error(\`ollama HTTP ${res.status}: ...\`)`). If Ollama
isn't running, `fetch` rejects with a connection error; if the model isn't
pulled or is mid-load, you get a 404/500. Either way the error propagates up
exactly like a cloud failure — and the same fallback chain catches it. The
takeaway: an external dependency on `localhost` is still a coordination
boundary. The RAG agent (`packages/agents/rag-query/scripts/ask.ts`) depends on
Ollama being up for *both* embeddings and reasoning — two endpoints on one
external process. → see `01` (the map now has three boxes), `02`.

### 4. Retry-on-parse is a local resilience pattern distinct from failover (★ real, new)

`packages/providers/gemma/src/gemma-provider.ts:62-89` — Gemma2:9b has no native
tool-calling, so the provider *emulates* it: it asks for a JSON tool call, and
if the reply is a botched one (`looksLikeToolAttempt` — a stray `{`), it appends
a corrective `RETRY_NUDGE` and asks again, up to `maxToolCallAttempts` (default
2). This is a **same-target retry loop** — the one pattern the fallback chain
deliberately *doesn't* have (it switches nodes instead). It's bounded
(`maxAttempts`), it's a no-op for plain prose (a real answer isn't retried), and
it gives up gracefully (returns the raw text). It's not failover and it's not a
network retry — it's "the model fumbled the format, nudge it once." Closest
in-repo cousin to the agent loop's JSON re-prompt. → see `02` (Step on
same-target retry), `03`.

### 5. Bounded turns + cancellation = the in-process safety rails (★ real, but in-process)

`packages/runtime/src/run-agent-loop.ts:98` — the loop is hard-capped at
`maxTurns` (default 8) and `maxToolCalls`. `:99`, `:209` — `signal.throwIfAborted()`
checks the `AbortSignal` before every model call and recovery turn. The
re-prompt on parse failure (`:192-199`) is the closest thing to an
"idempotent retry" the repo has — it re-runs the conclusion step from the same
recorded context. This is bounded work and cancellation (runtime-systems'
territory) doing double duty as a partial-failure guard. → see `02`, `03`.

### 6. The usage ledger is accounting across many provider calls (~ weak analog)

`packages/runtime/src/usage-ledger.ts:25-42` — `summarizeUsage()` folds every
`model_usage` event in a trace into one row (total input/output tokens, turn
count). It's the nearest thing to "tracking work across nodes," except the
"nodes" are sequential calls to the same external API from one process. → see `03`.

### 7. Replay is deterministic re-execution from a recorded log (~ recovery/idempotency analog)

`packages/evals/src/replay-runner.ts` + `FixtureModelProvider`
(`packages/agents/recommendation/src/fixture-provider.ts:11-17`) — replay swaps
the live provider for one that returns recorded `ModelResponse[]` in order. Same
input log → same output, deterministically. That's the *shape* of recovery from
a write-ahead log or event replay, used here for testing, not failure recovery.
The `CapabilityEvent` trace (`packages/runtime/src/events.ts:1-24`) is an
event-sourcing analog — an append-only log of what happened. → see `03`, `08`.

## `not yet exercised` — the honest list

These are real distributed-systems concepts AptKit has **no instance of.** The
guide teaches each as a foundation and names the trigger that would make it
real. Most of the topic surface lands here:

| Concept | Status | Trigger that would make it real |
| --- | --- | --- |
| Consensus / quorum | not yet exercised | A second replica of any state that must agree |
| Replication | not yet exercised | Any state stored in >1 place that must converge |
| Partitioning / sharding | not yet exercised | A dataset too big for one node |
| Leader election | not yet exercised | >1 process that must pick one coordinator |
| Message queues / streams | not yet exercised | Async hand-off between producer and consumer |
| Backpressure | not yet exercised | A queue that can fill faster than it drains |
| Poison messages / DLQ | not yet exercised | A durable queue with retry semantics |
| Logical clocks / ordering | not yet exercised | Concurrent writers needing a happens-before order |
| Distributed transactions / 2PC | not yet exercised | A write spanning two systems that must both commit |
| Sagas / compensation | not yet exercised | A multi-step external workflow needing rollback |
| Transactional outbox | not yet exercised | A DB write + a message publish that must be atomic |
| Read-your-writes / session consistency | not yet exercised | A replicated read path with a write path |
| Split-brain | not yet exercised | >1 node that could each think it's the leader |

The single-process design is *why* none of these exist — and that's the right
call for a library. You don't add Raft to a `.map()`. The trigger column is the
load-bearing part: it tells you exactly when each concept stops being academic.
Several of these triggers (a hosted `PgVectorStore`, laptop↔phone memory sync,
a multi-platform gateway) are already *planned* — but in the separate `buffr`
repo, explicitly out of aptkit's scope (`docs/personal-agent-packages.md:81-86`).
When that plane gets built, this table is the checklist of what becomes real.

## The fallacies of distributed computing — which ones bite here

The eight fallacies (Deutsch/Gosling) are the assumptions that quietly break
distributed code. AptKit reaches across a network boundary in one *kind* of place
(cloud HTTPS and localhost HTTP), so only the fallacies about *those hops* apply:

```
  The 8 fallacies — does AptKit's external-service edge violate it?

  1. The network is reliable      ── YES, bites: provider/Ollama calls fail → fallback
  2. Latency is zero              ── YES, bites: every complete()/embed() is a round-trip
  3. Bandwidth is infinite        ── partial: large prompts → context guard
  4. The network is secure        ── partial: cloud uses TLS; the Ollama hop is
                                     plain HTTP on localhost (no TLS, no auth) →
                                     security guide owns this
  5. Topology doesn't change      ── n/a: one fixed endpoint per provider/host
  6. There is one administrator   ── YES (cloud), bites: the provider's admin, not you
  7. Transport cost is zero       ── YES (cloud): usage ledger tracks $ per call
                                     (Ollama is free, so $ cost is local-only)
  8. The network is homogeneous   ── partial: three API shapes (Anthropic, OpenAI,
                                     Ollama) behind one ModelProvider contract
```

Fallacies 1, 2, 6, 7 are the ones AptKit actually has to handle. The fallback
chain answers #1 for *both* flavors (a down Ollama fails over to cloud just like
a 503 does), bounded turns + the ledger answer #2 and #7, and #6 is *the whole
reason* the cloud fallback chain exists — the provider's rate limits and outages
are decided by someone who isn't you. The Ollama hop softens #6 (you run that
process) but not #1: a separate process can still be down.

## How to use this guide

Read `01` for the map. Read `02` and `03` slowly — they're the files grounded in
real code. Skim `04`–`08` to know the foundations and recognize the triggers.
Finish on `09` for the ranked risk audit. The goal is that you can walk into an
interview, draw the map above, and say with a straight face: "this system is
single-process by design; its distributed surface is external-service
dependencies — cloud LLM APIs and a local Ollama process — handled by one
fallback chain and a couple of bounded local retries. The multi-node,
sync, and Supabase plane is deliberately deferred to a separate repo (`buffr`);
aptkit stays a library. Here's exactly how it handles partial failure at those
edges — and here's what I'd add the day it grows a real second node."
