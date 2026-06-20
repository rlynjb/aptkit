# 02 — Partial failure, timeouts, retries, backoff

**Industry name(s):** partial failure handling / failover / retry-with-backoff /
fail-fast / retry-on-parse. **Type:** Industry standard.

This is the one file that genuinely lives in this repo. Read it slowly. It now
covers three real resilience patterns: **fail-fast** (context guard),
**failover** (the fallback chain), and **same-target retry-on-parse** (the Gemma
provider's tool-call nudge loop) — and two flavors of the failure they defend
against: cloud HTTPS errors and local Ollama-process errors.

## Zoom out, then zoom in

The fallback chain and the context guard both sit right at the seam — the
`ModelProvider.complete()` boundary where the failure axis flips. They're the
code that runs when node B (the provider) misbehaves.

```
  Zoom out — where partial-failure handling lives

  ┌─ Service layer (your process) ──────────────────────────────┐
  │  runAgentLoop ── signal.throwIfAborted() ── bounded turns     │
  └─────────────────────────────┬────────────────────────────────┘
                               │ complete() / embed()
  ┌─ Provider boundary ─────────▼────────────────────────────────┐
  │  ★ ContextGuard (fail-fast) → Fallback (failover) ★           │ ← we are here
  │  Anthropic · OpenAI adapters    Gemma (retry-on-parse) · embed │
  └──────────────┬───────────────────────────────┬────────────────┘
       HTTPS — timeout/429/5xx │        HTTP localhost — down/loading │
  ┌─ Cloud provider ─▼────────┐  ┌─ Local Ollama process ─▼──────────┐
  │  api.anthropic.com / openai │  │  :11434 — ECONNREFUSED / 404 / slow│
  └─────────────────────────────┘  └────────────────────────────────────┘
```

Zoom in: **partial failure** is the defining problem of distributed systems.
In a single function call, it either returns or throws — two outcomes. Across a
network (even a localhost socket), there's a third: *you don't know.* The
request might have succeeded on the other side while your connection died.
AptKit's answer to "an external service is misbehaving" is three patterns:
**fail-fast** (don't even make a call that's doomed), **failover** (when one
provider fails, try the next), and **retry-on-parse** (when a local model
fumbles the response *format*, nudge it and ask once more). The first two guard
against transport failure; the third guards against a weak model's bad output —
a failure mode the cloud SDKs hide but a raw Ollama call exposes.

## Structure pass — layers, axis, seams

Trace the **failure axis** across three nested handlers, all on the request
path:

```
  "what happens to a failure?" — traced down the request path

  ┌──────────────────────────────────────────────┐
  │ runAgentLoop                                   │ → bounds the blast radius:
  │                                                │   maxTurns caps how many
  │                                                │   times you can even try
  └────────────────────┬───────────────────────────┘
      ┌────────────────▼─────────────────────────────┐
      │ FallbackModelProvider                          │ → catches a provider
      │                                                │   error, classifies it,
      │                                                │   fails over to the next
      └────────────────┬───────────────────────────────┘
          ┌────────────▼─────────────────────────────┐
          │ ContextWindowGuardedProvider              │ → refuses to call at all
          │                                           │   if the request is doomed
          └────────────┬───────────────────────────────┘
                       ▼
              the actual HTTPS round-trip (provider SDK)
```

Two seams matter. The **fail-fast seam** (context guard) is where a request
dies *before* the network — cheap, local, deterministic. The **failover seam**
(fallback chain) is where one node's failure gets converted into a try against
a different node. The axis flips at each: above the guard, a too-big request is
just data; below it, it's a refused call. Above the fallback loop, an error is
fatal; inside it, it's a reason to try the next provider.

## How it works

### Move 1 — the mental model: a loop over fallbacks

You already know the shape from a `fetch()` with a `try/catch` and a retry. The
fallback chain is that, generalized: try a list of providers in order, catch
each failure, move on, and only give up when the list is exhausted.

```
  The failover loop — the kernel

  providers = [primary, secondary, ...]
  attempts  = []
  ┌─────────────────────────────────────────────┐
  │ for each provider in order:                  │
  │   ├─ is the request cancelled? → abort       │
  │   ├─ try provider.complete()                 │
  │   │    success → return response  ◄──────────┼── exit on first win
  │   └─ catch error:                            │
  │        ├─ cancelled? → rethrow (don't retry) │
  │        ├─ record attempt                     │
  │        └─ shouldFallback? → next  : rethrow  │
  └─────────────────────────────────────────────┘
  all failed → throw ProviderFallbackError(attempts)
```

Three parts make this the pattern, and each breaks something specific if
removed:

- **The ordered list + early return.** Without it there's no failover at all —
  you'd call one provider and stop. The early-return-on-success is what makes it
  "use the first one that works."
- **`shouldFallback` classification.** Without it, you retry on errors you
  shouldn't (a malformed-request 400 will fail on *every* provider — retrying
  wastes time and money). Classification is what separates "this node is down,
  try another" from "this request is broken, stop."
- **The aggregated `ProviderFallbackError`.** Without it, when everything fails
  you lose the per-attempt detail and can't tell *why* each node failed. The
  aggregation is the observability that makes a total failure debuggable.

### Move 2 — the walkthrough

**Step 1 — fail-fast before the network (the context guard).** Bridge from
form validation: you don't POST a form you know is invalid; you validate
client-side first. The context guard does the same for token budget — it
estimates the request size and refuses if it can't fit, *before* paying for a
round-trip that the provider would reject anyway.

```
  Fail-fast — refuse the doomed call locally

  request ──► estimate input tokens ──► ok?
                                         ├─ yes → forward to real provider
                                         └─ no  → emit warning + throw
                                                  ContextWindowExceededError
                                                  (no network call made)
```

The boundary condition: the estimate is a heuristic (`charsPerToken`), so it's
conservative, not exact. It can refuse a request that *would* have fit, or pass
one that's slightly over. That's fine — fail-fast guards are allowed to be
approximate as long as they err toward refusing early.

**Step 2 — the sequential try (failover).** Bridge from `Promise` chaining with
`.catch()`: each `catch` decides whether to recover or rethrow. The fallback
loop is a sequential — *not* parallel — walk. It tries provider 1, and only if
it fails does it try provider 2.

```
  Sequential failover — one at a time, layers-and-hops

  ┌─ your process ─┐  hop 1: complete()   ┌─ provider 1 ─┐
  │  fallback loop │ ───────────────────► │  Anthropic   │
  │                │ ◄─── 503 / timeout ── └──────────────┘
  │                │
  │  classify: shouldFallback? yes        ┌─ provider 2 ─┐
  │                │  hop 2: complete()   │  OpenAI      │
  │                │ ───────────────────► │              │
  │                │ ◄─── 200 + response ─└──────────────┘
  │  return ◄──────┘  (first success wins)
  └────────────────┘
```

Why sequential and not parallel (hedged requests)? Parallel would be faster on
the tail but doubles cost and load on providers you're rate-limited against
(fallacy #7 — transport cost isn't zero). Sequential is the right default for a
cost-sensitive library: you only pay for provider 2 when provider 1 actually
failed. The cost is latency — a failed primary means you eat its full
timeout before even starting the secondary.

**Step 3 — error classification (`shouldFallback`).** This is the part people
forget. Not every error means "try another node." A 429 (rate limited) or 503
(down) → yes, fail over. A 400 (your request is malformed) → no, every provider
will reject it identically, so stop now. AptKit's default `shouldFallback` is
`() => true` (fail over on anything), but the hook exists so a caller can inject
real classification.

```
  Classification — the decision that prevents pointless retries

  error from provider
    ├─ AbortError / cancelled  → rethrow immediately (caller wants to stop)
    ├─ shouldFallback(error)?
    │     true  → record attempt, try next provider
    │     false → rethrow (e.g. 400 — broken everywhere)
    └─ last provider?          → throw ProviderFallbackError(all attempts)
```

**Step 4 — cancellation wins over failover.** The `AbortError` passthrough is
the subtle correctness move. If the caller aborts mid-chain, you must *not*
helpfully fail over to the next provider — the caller said stop. So abort errors
bypass classification entirely and rethrow. This is the seam where in-process
cancellation (runtime-systems' concern) meets failover (this guide's concern).

**Step 4.5 — retry-on-parse: the one same-target retry in the repo.** Bridge
from the agent loop's JSON re-prompt (`03`): when the model returns malformed
output, you don't fail over — you ask the *same* model again with a corrective
nudge. The Gemma provider does exactly this for tool-call emulation. Gemma2:9b
has no native tool-calling, so the provider renders the tools into the system
prompt and asks for a JSON tool call. If the reply is a *botched* one — it looks
like an attempt (contains a `{`) but doesn't parse — the provider appends a
`RETRY_NUDGE` and asks again, up to `maxToolCallAttempts` (default 2).

```
  Retry-on-parse — the kernel (same target, bounded, format-only)

  for attempt in 0..maxAttempts:
    reply = ollama.chat(messages + (attempt>0 ? RETRY_NUDGE : []))
    call  = parseToolCall(reply)
    ├─ parsed ok        → return tool_use(call)      ◄── success exits
    ├─ looksLikeAttempt → continue (nudge & retry)   ◄── botched JSON → one more try
    └─ plain prose      → break (it's a real answer, NOT an error)
  give up → return text(reply)                       ◄── graceful: raw text, no throw
```

Three parts make this the pattern, each load-bearing:

- **The bound (`maxToolCallAttempts`).** Without it, a model that *never* emits
  valid JSON loops forever. The cap is the same instinct as the agent loop's
  `maxTurns` — every retry loop against an unreliable producer needs a ceiling.
- **The `looksLikeToolAttempt` gate.** This is the part people get wrong. You
  only retry if the model *tried and failed* to call a tool (a stray `{`). Plain
  prose is a *real answer*, not an error — retrying it would nag the model into
  garbage. Distinguishing "fumbled the format" from "chose to answer directly"
  is the whole subtlety.
- **The graceful give-up.** After `maxAttempts`, it returns the raw text instead
  of throwing. A weak local model degrading to a plain answer beats crashing the
  run.

Why this is *not* failover and *not* a network retry: the network call
succeeded — Ollama answered. The failure is *semantic* (wrong format), and the
fix is to re-ask the same node with better instructions. This is the resilience
pattern the cloud SDKs give you for free (Anthropic emits structured
`tool_use` natively) and that a raw local model forces you to build yourself.

**Step 5 — backoff and jitter: the missing hardening.** Here's the honest part.
AptKit's *failover* has **no delay between attempts** — it tries provider 2
immediately after provider 1 fails. There's no exponential backoff, no jitter,
and no retry of the same provider *on a transport error*. (The Gemma
retry-on-parse loop from Step 4.5 retries the same target, but on a *parse*
failure after a successful response — not a network error, so it needs no
backoff: the node isn't overloaded, it just answered badly.) For a two-provider
failover that's fine — you're switching nodes, not hammering one — but it means
the transport-level foundation below is `not yet exercised`:

```
  Exponential backoff with jitter — the textbook pattern (NOT in AptKit)

  attempt 1 ──► fail ──► wait base·2⁰ ± jitter  (e.g. ~1s)
  attempt 2 ──► fail ──► wait base·2¹ ± jitter  (e.g. ~2s)
  attempt 3 ──► fail ──► wait base·2² ± jitter  (e.g. ~4s)
  ...capped at a max delay, with jitter to avoid the
     thundering herd (every client retrying in lockstep)
```

The trigger that would make backoff real: **retrying the same provider** after a
transient 429/503. The moment you retry one node instead of switching nodes,
you need backoff (to give it time to recover) and jitter (so a fleet of clients
doesn't synchronize their retries into a self-inflicted DDoS). AptKit sidesteps
this because it switches nodes instead of retrying one — but a senior engineer
should name the gap out loud.

### Move 3 — the principle

Partial failure is the only thing that makes a network call different from a
local one, and there are a small number of honest responses: **don't make the
call if it's doomed** (fail-fast), **have a plan B when it fails anyway**
(failover), and **re-ask the same node when it answered but answered wrong**
(retry-on-parse). AptKit does all three at the boundaries that need them. The
discipline that scales beyond this repo: *classify your failures* — not just
"transient vs permanent" for transport (failover), but "transport failed" vs
"the response is unusable" (retry-on-parse). Conflating the two is how systems
fail over on a parse bug, or nag a healthy node into garbage.

## Primary diagram

Everything Move 2 walked — fail-fast, then sequential failover with
classification and abort passthrough.

```
  The full partial-failure path

  ┌─ runAgentLoop (bounds attempts) ─────────────────────────────┐
  │  signal.throwIfAborted()  ── cancellation checked first       │
  └────────────────────────────┬──────────────────────────────────┘
                              │ complete()
  ┌─ ContextWindowGuardedProvider (FAIL-FAST) ─▼─────────────────┐
  │  estimate tokens ─ fit? ── no → throw (no network)            │
  │                          └─ yes ▼                             │
  └────────────────────────────────┼─────────────────────────────┘
  ┌─ FallbackModelProvider (FAILOVER) ─▼─────────────────────────┐
  │  for provider in [p1, p2, ...]:                               │
  │    throwIfAborted()                                           │
  │    try complete() → success? return ◄── first win exits       │
  │    catch:                                                     │
  │      abort?         → rethrow (cancellation wins)             │
  │      shouldFallback → record + next                           │
  │      else           → rethrow                                 │
  │  exhausted → throw ProviderFallbackError(attempts)            │
  └────────────────────────────┬──────────────────────────────────┘
                              │ HTTPS  ◄── partial failure originates here
  ┌─ provider APIs ─────────────▼────────────────────────────────┐
  │  timeout / 429 / 5xx / partial response / success             │
  └───────────────────────────────────────────────────────────────┘

  MISSING (not yet exercised): backoff, jitter, same-provider retry.
```

## Implementation in codebase

**Use cases.** The fallback chain is reached for whenever a run is configured
with more than one provider — the production posture where Anthropic is primary
and OpenAI is the backup, or where a local Gemma is primary and a cloud provider
is the safety net behind it (`provider-gemma`'s README spells out exactly this
composition: guard the local model, then put it behind the fallback chain). The
context guard wraps a local/cheap provider so a too-large prompt is rejected
before wasting a call — load-bearing for Gemma, whose ~8k context is small and
easy to overrun (`ask.ts:52` wraps it at `maxTokens: 8192`). The Gemma
retry-on-parse loop runs on every tool-calling turn against a local model. All
three run inside the RAG query agent.

**The failover loop, line by line.**

```
  packages/providers/fallback/src/fallback-provider.ts  (lines 47-89)

  for (let index = 0; index < this.providers.length; index += 1) {  ← ordered walk
    const provider = this.providers[index];
    request.signal?.throwIfAborted();        ← cancellation checked BEFORE each try
    try {
      const response = await provider.complete(request);  ← the actual hop
      this.lastSelectedProvider = { ... };   ← record which node won (observability)
      return { ...response, model: ... };     ← FIRST SUCCESS EXITS the loop
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) throw error;
                                              ← cancellation wins: do NOT fail over
      const attempt = { providerId, model, error: ... };
      attempts.push(attempt);                 ← accumulate for the aggregate error
      if (!this.shouldFallback(error, provider)) throw error;
                                              ← classification: permanent? stop now
      if (index < this.providers.length - 1)  ← only warn if a fallback remains
        this.trace?.emit({ type: 'warning', ... });  ← observability on each failover
    }
  }
  throw new ProviderFallbackError(attempts);  ← all nodes failed: aggregate + throw
       │
       └─ the throwIfAborted-before-try + abort-passthrough-in-catch is the
          load-bearing pair: without it, an aborted request would keep failing
          over to every provider instead of stopping. That's the bug people ship.
```

**The aggregated error.**

```
  packages/providers/fallback/src/fallback-provider.ts  (lines 16-24)

  class ProviderFallbackError extends Error {
    readonly attempts: readonly FallbackAttempt[];   ← every node's failure, kept
    constructor(attempts) {
      super(`all model providers failed: ${attempts.map(a =>
        `${a.providerId}: ${a.error}`).join('; ')}`);  ← human-readable roll-up
      ...
    }
  }
       │
       └─ without this, a total outage gives you one opaque "it failed." With it,
          you get "anthropic: 503; openai: 429" — which is the difference between
          a 2-minute and a 2-hour debugging session.
```

**The fail-fast guard.**

```
  packages/providers/local/src/context-window-guard.ts  (lines 57-71)

  async complete(request) {
    request.signal?.throwIfAborted();              ← honor cancellation first
    const estimate = estimateContextWindow(request, this.options);
    if (!estimate.ok) {                            ← request won't fit?
      this.options.trace?.emit({ type: 'warning', ... });  ← say why, in the trace
      throw new ContextWindowExceededError(estimate);      ← refuse BEFORE the network
    }
    return this.provider.complete(request);        ← only now pay for the round-trip
  }
       │
       └─ the throw-before-delegate is the whole pattern: a local, cheap,
          deterministic check that prevents a remote, expensive, certain failure.
```

**The retry-on-parse loop, line by line.**

```
  packages/providers/gemma/src/gemma-provider.ts  (lines 62-91)

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {  ← bounded retry
    request.signal?.throwIfAborted();          ← cancellation wins, every iteration
    const messages = attempt === 0             ← first try: plain messages
      ? baseMessages
      : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];  ← retry: + nudge
    lastResponse = await this.chat({ ... });   ← the network call to Ollama
    raw = lastResponse.message?.content ?? '';
    if (wantsTool) {
      const call = parseToolCall(raw);         ← try to decode a tool call
      if (call) return this.toResponse([tool_use], ...);  ← SUCCESS exits the loop
      if (looksLikeToolAttempt(raw)) continue; ← botched JSON ('{')? nudge & retry
    }
    break;                                     ← plain prose = real answer, stop
  }
  return this.toResponse([{ type: 'text', text: raw }], ...);  ← graceful give-up
       │
       └─ the looksLikeToolAttempt gate at :86 is load-bearing: without it, a
          plain-prose answer ("It is sunny in Paris.") would be retried as if it
          were a failure, nagging the model. With it, only a fumbled tool call
          (a stray '{') triggers the nudge. "Format wrong" vs "chose prose" is
          the distinction the whole loop hinges on.
```

**The Ollama edge — where the local partial failure surfaces.**

```
  packages/providers/gemma/src/gemma-provider.ts:201-215
  packages/retrieval/src/ollama-embedding-provider.ts:60-75   (same shape)

  const res = await fetch(`${base}/api/chat`, { ... });  ← localhost socket call
  if (!res.ok) {                                          ← Ollama answered non-2xx?
    throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
  }                                                       ← 404 (model not pulled),
                                                            500 (mid-load) → throw
       │
       └─ if Ollama isn't running at all, `fetch` itself rejects (ECONNREFUSED)
          before this line — that rejection propagates up identically. Either way
          the error reaches the fallback chain, which can fail over to a cloud
          provider. A localhost dependency is still a partial-failure source.
```

**Where backoff/timeout would live, and why they don't (yet).** The Anthropic
adapter (`packages/providers/anthropic/src/anthropic-provider.ts:28-39`) passes
`request.signal` straight to `client.messages.create(...)` and sets no explicit
timeout or `maxRetries` — it relies on the **SDK's built-in retry/timeout
defaults**, which AptKit doesn't override. The Ollama edges have *no* SDK and
*no* explicit timeout at all — a hung Ollama call is bounded only by
`AbortSignal` and the loop's `maxTurns`, never a per-call deadline. So:

- **Explicit timeout:** `not yet exercised` at AptKit's layer — delegated to the
  SDK for cloud, *absent entirely* for the Ollama edges (no SDK, no default).
  *Trigger: needing a tighter deadline than the SDK default, e.g. a UI that must
  respond in 2s, or capping a slow first-token from a cold local model.*
- **Backoff + jitter:** `not yet exercised`. *Trigger: retrying the same
  provider on a transient transport error instead of switching nodes.*
- **Same-target *transport* retry:** `not yet exercised`. The Gemma
  retry-on-parse loop (Step 4.5) retries the same target on a *parse* failure,
  but no path retries a node on a *network* failure. *Trigger: a single-provider
  deployment where there's no second node to fail over to, so a transient 429/503
  must be retried in place.*

## Elaborate

The fail-fast / failover pair is older than "distributed systems" as a term —
it's the resilience core of every networked client. The backoff-with-jitter
pattern specifically comes from Ethernet's collision avoidance and was
popularized for cloud APIs by AWS's "exponential backoff and jitter" writeup;
the insight is that *correlated* retries (every client backing off by the same
fixed amount) recreate the overload they were meant to relieve, so you randomize.
AptKit doesn't need it yet because it fails *over* rather than *back*, but the
day it retries one endpoint, jitter is non-negotiable.

The neighbor `study-networking` owns what "timeout" and "503" actually mean on
the wire (socket timeouts vs response timeouts, TLS handshake failures);
`study-runtime-systems` owns the `AbortSignal` mechanics. This file owns the
*decision* made when those failures surface.

## Interview defense

**Q: "A provider call fails. Walk me through what happens."**

Draw the failover loop. "We classify the error first — if it's a cancellation,
we rethrow; the caller wants to stop. If it's a fail-over-able error, we record
the attempt and try the next provider. First success wins. If everything fails,
we throw a `ProviderFallbackError` that carries every attempt's reason."

```
  complete() → catch → abort? rethrow : shouldFallback? next : rethrow
                                              │
                                        exhausted → ProviderFallbackError(all)
```

Anchor: "`fallback-provider.ts:47-89`. The load-bearing detail people miss is
the abort passthrough at line 65 — without it, an aborted request keeps failing
over instead of stopping."

**Q: "Where's your backoff and jitter?"**

Don't bluff. "We don't have them, on purpose — we fail *over* to a different
node rather than retrying the *same* one, so there's nothing to back off
against. The moment we add same-provider retry, we need exponential backoff with
jitter to avoid a thundering herd. That's the trigger."

```
  fail OVER (switch nodes)  → no backoff needed   ← what AptKit does
  fail BACK (retry node)    → backoff + jitter    ← the trigger for adding it
```

**Q: "You have a retry loop in the Gemma provider AND a fallback chain. Aren't
those the same thing?"**

"No — they defend against different failures. The fallback chain handles
*transport* failure: a provider threw, so try a different node. The Gemma loop
handles *semantic* failure: the call succeeded, Ollama answered, but the answer
was a malformed tool call — so I re-ask the *same* node with a corrective nudge.
Different failure, different fix. The tell is that the Gemma retry needs no
backoff: the node isn't overloaded, it just fumbled the format."

```
  transport failed → fallback chain → switch to a different node
  response unusable → Gemma loop     → re-ask the SAME node, nudged
                                       (bounded by maxToolCallAttempts)
```

Anchor: "`gemma-provider.ts:62-91`. The load-bearing detail is the
`looksLikeToolAttempt` gate at :86 — I only retry a *fumbled* tool call, never a
plain-prose answer, because prose is a real answer, not an error."

## Validate

1. **Reconstruct:** Write the failover loop's kernel from memory — the four
   branches inside the `catch`.
2. **Explain:** Why does the abort error bypass `shouldFallback` entirely
   (`fallback-provider.ts:65`)? What bug appears if it didn't?
3. **Apply:** A provider starts returning 400s for malformed requests. With the
   default `shouldFallback = () => true`, what happens — and what should you
   inject instead?
4. **Defend:** Argue for sequential failover over parallel hedged requests for
   this repo, naming the cost you accept (`fallback-provider.ts:50-86`).
5. **Apply:** Ollama is stopped while a RAG run is mid-question. Trace what
   throws and where (`ollama-embedding-provider.ts:60-75`), and explain how the
   fallback chain can — or can't — recover, depending on whether the failure is
   on the embed edge or the chat edge.
6. **Defend:** Why does the Gemma retry-on-parse loop (`gemma-provider.ts:62-91`)
   need *no* backoff, while a same-provider transport retry would? Tie it to
   *what* failed in each case.

## See also

- `01-distributed-system-map.md` — the seam where these handlers sit (now three
  nodes: your process, cloud, and the local Ollama process).
- `03-idempotency-deduplication-and-delivery-semantics.md` — what makes a retry
  *safe* to perform (the Gemma nudge-retry is safe because chat is read-only).
- `study-networking` — what timeouts and 5xx mean on the wire (and the localhost
  HTTP hop to Ollama).
- `study-runtime-systems` — `AbortSignal` and bounded work.
- `study-ai-engineering` / `study-agent-architecture` — the RAG pipeline and
  tool-call emulation these failures sit inside.
