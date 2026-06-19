# 09 — Distributed-systems red-flags audit

**Industry name(s):** coordination risk audit / partial-failure review.
**Type:** Project-specific.

This file ranks the actual coordination and partial-failure risks in *this*
repo, by consequence. The honest headline carries through: AptKit is
single-process; the only place these risks can bite is the provider boundary.
The list is short on purpose — inventing risks for a system that doesn't have
them would be the worst kind of distributed-systems theater.

## Zoom out — where the risks concentrate

Every real risk lives at, or just inside, the one network hop. Above it, failures
are ordinary in-process exceptions; the risks here are about what happens when
node B misbehaves and node A has to cope.

```
  Zoom out — the risk surface is one arrow

  ┌─ Service layer (your process) ──────────────────────────────┐
  │  bounded loop · re-prompt · ledger — LOW risk (in-process)    │
  └─────────────────────────────┬────────────────────────────────┘
                               │ complete()  ◄── ALL real risk here
  ┌─ Provider boundary ─────────▼────────────────────────────────┐
  │  no backoff · no timeout override · default shouldFallback     │ ← the findings
  └─────────────────────────────┬────────────────────────────────┘
                               │ HTTPS — partial failure
  ┌─ External provider ─────────▼────────────────────────────────┐
  └───────────────────────────────────────────────────────────────┘
```

## Structure pass — the axis for ranking

Rank by the **failure axis**: for each finding, how bad is the consequence when
the provider boundary misbehaves, and how likely is the trigger? A risk that's
both consequential and easy to hit ranks above a foundational gap that only
matters if the system grows a second node.

## Ranked findings

### R1 — `shouldFallback` defaults to "retry everything" (MEDIUM)

**Evidence:** `packages/providers/fallback/src/fallback-provider.ts:44` —
`this.shouldFallback = options.shouldFallback ?? (() => true)`.

**The risk:** with the default, a *permanent* error (a 400 for a malformed
request, an auth failure from a bad API key) triggers a failover to the next
provider — which will reject it identically. You pay the latency and cost of
trying every provider for an error that no provider can succeed on. For a
two-provider chain that's one wasted call; for a longer chain it's N wasted
calls per request, and it masks the real bug (the malformed request) behind a
generic `ProviderFallbackError`.

**The fix:** inject a `shouldFallback` that classifies — fail over on
429/503/network errors, rethrow immediately on 4xx-except-429. The hook exists
(`:73`); it's just not used with real classification by default.

```
  R1 — the wasted-failover path

  malformed request → p1: 400 → shouldFallback()=true → p2: 400 → ... → all fail
                                       │
                          should have been: 400 → rethrow now (broken everywhere)
```

### R2 — no backoff / no same-provider retry (LOW, by design)

**Evidence:** `fallback-provider.ts:50-86` — the loop moves to the next provider
with zero delay; there is no retry of the *same* provider and no backoff/jitter.

**The risk:** low *today* because AptKit fails *over* (switches nodes) rather
than *back* (retries one), so there's nothing to hammer. The risk is latent: the
moment anyone adds same-provider retry on a transient 429/503 without backoff,
they create a thundering-herd / self-DDoS hazard. Flagged so the gap is named
before someone "helpfully" adds a naive retry.

**The fix when triggered:** exponential backoff + jitter on same-provider retry.
See `02`, Step 5.

### R3 — no explicit timeout at AptKit's layer (LOW)

**Evidence:** `packages/providers/anthropic/src/anthropic-provider.ts:28-39`
passes `request.signal` to the SDK but sets no `timeout` or `maxRetries` —
AptKit relies on the provider SDK's defaults.

**The risk:** the effective request deadline is whatever the SDK defaults to,
not something AptKit controls or documents. A hung provider connection is
bounded only by the SDK timeout + the loop's `maxTurns`, not by an explicit
per-call deadline. Fine for a CLI/dev tool; a problem the day a latency-sensitive
caller (a UI with a 2s budget) needs a tighter, explicit deadline.

**The fix when triggered:** pass an explicit `timeout` into the SDK client, or
wrap `complete()` with an `AbortSignal.timeout(ms)`.

### R4 — `AbortError` detection is duck-typed by name (LOW)

**Evidence:** `fallback-provider.ts:92-95` and `run-agent-loop.ts:219` detect
cancellation via `error.name === 'AbortError'` (and `instanceof DOMException`).

**The risk:** correctness of the "cancellation wins over failover" rule (the
load-bearing detail from `02`/`03`) depends on the error *name* string. A
provider SDK that throws a cancellation error with a different `name` would
slip through, get classified as a normal failure, and trigger an *unwanted
failover* on a request the caller already aborted. Low likelihood (the SDKs use
standard `AbortError`), but the correctness of the abort path rests on a string
match.

**The fix when triggered:** check the signal's `aborted` state directly
(already done partially at `fallback-provider.ts:65` via
`request.signal?.aborted`) rather than relying solely on the error name.

### R5 — usage-ledger pricing covers only `gpt-4.1-*` (INFORMATIONAL)

**Evidence:** `packages/runtime/src/usage-ledger.ts:71-78` —
`pricingForModel` returns `undefined` for any non-OpenAI provider and any model
outside the `gpt-4.1` family (including all Anthropic models).

**The risk:** not a coordination risk — a cost-observability gap. The "accounting
across calls" analog (the closest thing to tracking work across nodes, `03`)
silently reports `n/a` cost for Anthropic-served turns. Token counts are still
summed correctly; only the dollar estimate is missing. Flagged because cost
tracking is fallacy #7 ("transport cost is zero" is false) and the ledger is
where AptKit answers it — incompletely.

**The fix:** add Anthropic pricing rows to `pricingForModel`.

## The non-findings — deliberately absent

These are the risks a checklist would expect that AptKit *correctly* doesn't
have, because it's single-process. Naming them as non-findings is the honest
audit:

```
  Non-findings — risks that DON'T apply (and why)

  split-brain          ── no leader election → impossible
  stale reads          ── no replicas/cache  → one copy of all state
  lost messages        ── no queue           → synchronous, no delivery to lose
  poison messages      ── no durable queue   → no redelivery loop
  quorum failure       ── no replicas        → nothing to count a majority of
  clock skew bugs      ── one process clock   → timestamps are a valid total order
  saga stranded state  ── read-only tools    → no side effect to compensate
  outbox dual-write    ── no DB + no broker   → no atomic write+publish to bungle
```

## Ranked summary

```
  Risk register — by consequence × likelihood

  R1  shouldFallback default = retry-all      MEDIUM   fallback-provider.ts:44
  R2  no backoff / same-provider retry         LOW*     fallback-provider.ts:50-86
  R3  no explicit timeout at AptKit's layer    LOW      anthropic-provider.ts:28-39
  R4  AbortError detected by name string       LOW      fallback-provider.ts:92-95
  R5  ledger pricing OpenAI-gpt-4.1 only       INFO     usage-ledger.ts:71-78

  * LOW today; becomes MEDIUM the instant same-provider retry is added.
```

The verdict: **for a single-process library, the partial-failure handling at the
one boundary is sound.** The fallback chain, fail-fast guard, bounded loop, and
abort passthrough are the right primitives. R1 is the one finding worth acting on
now (inject real error classification). The rest are latent gaps whose triggers
are clearly named — and most of the distributed-systems checklist correctly
doesn't apply, because the system has one node and one edge.

## Interview defense

**Q: "What's the biggest distributed-systems risk in this codebase?"**

"R1 — the fallback chain's `shouldFallback` defaults to retrying on *any* error,
including permanent ones like a 400. So a malformed request fails over to every
provider and fails identically, wasting cost and masking the real bug. The fix is
injecting real error classification — fail over on transient errors, rethrow on
permanent ones. The hook exists; it's just defaulted to 'retry everything.'"

```
  default shouldFallback = () => true  →  400 retried on every provider
  fix: classify — transient → next, permanent → rethrow now
```

**Q: "What distributed-systems problems does this system NOT have, and why?"**

"Split-brain, stale reads, lost messages, quorum failures — none of them, because
it's single-process. One copy of all state, one clock, no queue, no replicas, no
leader. The discipline is to handle the one real edge — the provider call — well,
and not bolt on machinery for failures that can't occur."

## Validate

1. **Reconstruct:** List the five findings ranked, with the one that's actionable
   today.
2. **Explain:** Why is R1 (`fallback-provider.ts:44`) a real cost/latency risk
   even though the chain "works"?
3. **Apply:** A teammate adds same-provider retry to handle 429s. Which finding
   jumps from LOW to MEDIUM, and what must they add alongside it?
4. **Defend:** Justify why split-brain and stale reads are non-findings here —
   tie each to a specific design fact about the repo.

## See also

- `00-overview.md` — the ranked findings in context.
- `02-partial-failure-timeouts-and-retries.md` — R1–R4 in depth.
- `03-idempotency-deduplication-and-delivery-semantics.md` — R5 (the ledger) and
  why retries are safe/unsafe.
- `study-networking` — what timeouts and 5xx mean on the wire (R3).
